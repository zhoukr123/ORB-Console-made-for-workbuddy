#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""ORB 看视频 · 探底与抽帧（随包分发的正式脚本，不是探针）

为什么是 Python 而不是纯 Node：
  探底和抽帧都要解复用 + 解码，Node 侧没有现成的零依赖方案；重打一个 ffmpeg.exe
  又和"工程零 ffmpeg"的既有设计正面冲突。所以只依赖 PyAV 一个包（它自带 FFmpeg 的
  共享库），用一个小运行时跑起来 —— 体积约 60 MB，和 2.1 GB 的识别环境完全无关。

为什么只有一个命令入口、JSON 走 stdout：
  主进程只要 spawn 一次拿一段 JSON，不用处理流式协议；进度靠"阶段串"打给 stderr，
  主进程按阶段更新面板文案即可。

硬约定（都是踩过的坑）：
  · 抽帧必须**顺序扫一遍**，禁止逐点 seek —— 630s 的片单遍 4.75s，逐点 seek 5 次就要 9.5s；
  · mjpeg 的 CodecContext **不能跨帧复用**（第二帧起 EINVAL 22），每帧新建；
  · venv 里没有 Pillow，`frame.to_image()` 会直接炸，只走 mjpeg 编码器出 JPEG 字节；
  · 无音轨的视频喂 ASR 会抛 IndexError —— 所以 hasAudio 必须在这里判出来。
"""
import sys
import os
import json
import time


def emit(obj):
    """结果统一从这些标记之间取，避免 PyAV / 警告的输出污染 JSON。"""
    sys.stdout.write("<<<ORB\n" + json.dumps(obj, ensure_ascii=False) + "\nORB>>>\n")
    sys.stdout.flush()


def note(msg):
    """阶段信息走 stderr，主进程按行读来更新进度文案。"""
    sys.stderr.write(str(msg) + "\n")
    sys.stderr.flush()


def fail(msg, code=2):
    emit({"ok": False, "error": str(msg)})
    return code


def load_av():
    try:
        import av  # noqa: F401
        return av
    except Exception as e:
        raise RuntimeError("缺少 PyAV（av）：%s" % e)


def probe(path):
    av = load_av()
    if not os.path.isfile(path):
        return {"ok": False, "error": "文件不存在：%s" % path}
    size = os.path.getsize(path)
    try:
        with av.open(path) as c:
            v = next((s for s in c.streams if s.type == "video"), None)
            a = next((s for s in c.streams if s.type == "audio"), None)
            if v is None:
                return {"ok": False, "error": "没有视频轨（可能是纯音频，请走音频链路）"}
            # duration 以容器为准；有些容器没有，就退回流时长，再退回 0
            dur = 0.0
            if c.duration:
                dur = float(c.duration) / float(av.time_base)
            elif v.duration and v.time_base:
                dur = float(v.duration * v.time_base)
            fps = 0.0
            try:
                if v.average_rate:
                    fps = float(v.average_rate)
            except Exception:
                pass
            out = {
                "ok": True,
                "durationSec": round(dur, 3),
                "width": int(v.codec_context.width or 0),
                "height": int(v.codec_context.height or 0),
                "fps": round(fps, 3),
                "videoCodec": str(v.codec_context.name or ""),
                "hasAudio": a is not None,
                "audioCodec": str(a.codec_context.name or "") if a is not None else "",
                "audioChannels": int(a.codec_context.channels or 0) if a is not None else 0,
                "audioSampleRate": int(a.codec_context.sample_rate or 0) if a is not None else 0,
                "sizeBytes": size,
                "avVersion": getattr(av, "__version__", ""),
            }
            return out
    except Exception as e:
        return {"ok": False, "error": "探底失败：%s" % e}


def frames(path, out_dir, interval=5.0, max_frames=200, max_width=960):
    """顺序扫一遍，每 interval 秒出一帧到 out_dir，返回每帧的秒数与文件名。

    只做一次解码遍历：解码成本是固定的，编码一帧才 ~7ms —— 所以"多存几帧"几乎免费，
    "多 seek 几次"才是真正的浪费。
    """
    av = load_av()
    if not os.path.isfile(path):
        return {"ok": False, "error": "文件不存在：%s" % path}
    try:
        os.makedirs(out_dir, exist_ok=True)
    except Exception as e:
        return {"ok": False, "error": "建目录失败：%s" % e}

    got = []
    next_at = 0.0
    t0 = time.time()
    try:
        with av.open(path) as c:
            v = next((s for s in c.streams if s.type == "video"), None)
            if v is None:
                return {"ok": False, "error": "没有视频轨"}
            # 循环计数只用于给主进程一个"还在动"的信号
            seen = 0
            for frame in c.decode(video=0):
                if frame.time is None:
                    continue
                t = float(frame.time)
                if t + 1e-6 < next_at:
                    seen += 1
                    continue
                # 缩放放在解码之后做：reformat 走 swscale，比二次解码便宜得多
                img = frame
                w = int(frame.width or 0)
                if max_width and w > max_width:
                    h = int(round(float(frame.height) * max_width / float(w)))
                    # 宽高都取偶数，避免某些编码器对奇数边长报错
                    h -= h % 2
                    img = frame.reformat(width=max_width, height=max(2, h), format="yuvj420p")
                cc = av.CodecContext.create("mjpeg", "w")
                cc.width = img.width
                cc.height = img.height
                cc.pix_fmt = "yuvj420p"
                packets = cc.encode(img)
                name = "f%05d.jpg" % len(got)
                fp = os.path.join(out_dir, name)
                with open(fp, "wb") as fh:
                    for p in packets:
                        fh.write(bytes(p))
                got.append({
                    "t": round(t, 3),
                    "file": name,
                    "w": int(img.width),
                    "h": int(img.height),
                    "bytes": os.path.getsize(fp),
                })
                next_at = t + float(interval)
                if len(got) >= int(max_frames):
                    break
                seen += 1
                if seen % 300 == 0:
                    note("scan %d frames, kept %d, at %.1fs" % (seen, len(got), t))
    except Exception as e:
        # 已经有帧就别整单失败：部分帧也能用，把错因带回去即可
        if got:
            return {"ok": True, "partial": True, "error": "抽帧中断：%s" % e,
                    "count": len(got), "frames": got,
                    "elapsedSec": round(time.time() - t0, 2)}
        return {"ok": False, "error": "抽帧失败：%s" % e}

    return {"ok": True, "count": len(got), "frames": got,
            "elapsedSec": round(time.time() - t0, 2),
            "interval": float(interval), "maxWidth": int(max_width)}


def audio(path, out_path, rate=16000):
    """把音轨解成 16k 单声道 wav。

    为什么要单独抽：ASR 服务的接口是 multipart 上传，直接把 300 MB 的 mp4 塞进去
    又慢又占内存；抽成 16k 单声道 PCM 之后 10 分钟的片子才 ~19 MB。
    也顺手解决了 DASH 音视频分离的片源（B 站的 m4s 音频流本身就是单独一个文件）。
    """
    av = load_av()
    if not os.path.isfile(path):
        return {"ok": False, "error": "文件不存在：%s" % path}
    try:
        with av.open(path) as c:
            a = next((s for s in c.streams if s.type == "audio"), None)
            if a is None:
                return {"ok": False, "error": "没有音轨"}
            out = av.open(out_path, "w")
            try:
                # PCM 16-bit 小端：faster-whisper 内部本来也要重采样到 16k，先做掉省一步
                st = out.add_stream("pcm_s16le", rate=int(rate), layout="mono")
                res = av.AudioResampler(format="s16", layout="mono", rate=int(rate))
                for frame in c.decode(audio=0):
                    for rf in res.resample(frame):
                        for pkt in st.encode(rf):
                            out.mux(pkt)
                for pkt in st.encode(None):
                    out.mux(pkt)
            finally:
                out.close()
        return {"ok": True, "path": out_path, "bytes": os.path.getsize(out_path), "rate": int(rate)}
    except Exception as e:
        return {"ok": False, "error": "取音轨失败：%s" % e}


def main(argv):
    if len(argv) < 2:
        return fail("用法：vidx_probe.py probe <file> | frames <file> <outDir> [--interval N] [--max N] [--width N] | audio <file> <out.wav>")
    cmd = argv[1]
    if cmd == "probe":
        if len(argv) < 3:
            return fail("probe 需要文件路径")
        emit(probe(argv[2]))
        return 0
    if cmd == "frames":
        if len(argv) < 4:
            return fail("frames 需要 文件路径 与 输出目录")
        interval, mx, wid = 5.0, 200, 960
        rest = argv[4:]
        for i, a in enumerate(rest):
            try:
                if a == "--interval" and i + 1 < len(rest):
                    interval = float(rest[i + 1])
                elif a == "--max" and i + 1 < len(rest):
                    mx = int(rest[i + 1])
                elif a == "--width" and i + 1 < len(rest):
                    wid = int(rest[i + 1])
            except Exception:
                pass
        emit(frames(argv[2], argv[3], interval, mx, wid))
        return 0
    if cmd == "audio":
        if len(argv) < 4:
            return fail("audio 需要 输入路径 与 输出 wav 路径")
        emit(audio(argv[2], argv[3]))
        return 0
    return fail("未知命令：%s" % cmd)


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception as e:  # 兜底：任何异常都要给出可读的 JSON，而不是空输出
        sys.exit(fail("未捕获异常：%s" % e))
