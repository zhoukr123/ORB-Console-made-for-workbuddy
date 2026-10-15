# -*- coding: utf-8 -*-
"""
给视频 / 音频文件生成 SRT 字幕（本地 Whisper，离线）。

用法：
  python make_srt.py  <视频或音频文件>  [-o 输出.srt]  [--lang zh]  [--beam 5]

支持格式：mp4 / mkv / avi / mov / webm / flv / ts / mp3 / wav / m4a …（由 PyAV/ffmpeg 解码）
默认输出到与源文件同目录、同名 .srt；识别同时打印带时间码的进度。
"""
import argparse
import os
import sys
import time

# 复用 asr_server 里已加载好的模型与配置（导入时会加载模型，约 10 秒）
from asr_server import model, MODEL_DIR, LANG  # noqa: E402


def fmt_ts(t: float) -> str:
    """秒 -> SRT 时间码 00:00:00,000"""
    if t < 0:
        t = 0
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}".replace(".", ",")


def main():
    ap = argparse.ArgumentParser(description="视频/音频 -> SRT 字幕（本地 Whisper）")
    ap.add_argument("input", help="视频或音频文件路径")
    ap.add_argument("-o", "--out", help="输出 .srt 路径（默认与源同名）")
    ap.add_argument("--lang", default=None, help="语言，如 zh / en；留空用服务默认（%s）" % (LANG or "auto"))
    ap.add_argument("--beam", type=int, default=5, help="beam size，1 更快、5 更准（默认 5）")
    a = ap.parse_args()

    src = os.path.abspath(a.input)
    if not os.path.isfile(src):
        sys.exit("文件不存在：" + src)
    out = a.out or os.path.splitext(src)[0] + ".srt"

    lang = (a.lang if a.lang is not None else (LANG or "")) or None
    if lang and lang.lower() in ("auto", "detect"):
        lang = None
    # 中文（或自动）时带「优先简体」提示词
    prompt = "以下是普通话的句子。" if (lang in (None, "zh")) else None

    print(f"模型: {MODEL_DIR}\n源文件: {src}\n输出: {out}\n开始转写…\n")
    t0 = time.time()
    segments, info = model.transcribe(
        src, language=lang, initial_prompt=prompt, beam_size=a.beam, vad_filter=True
    )

    lines = []
    n = 0
    for s in segments:                      # 生成器：边转写边产出，长文件不会一次性占满内存
        n += 1
        text = s.text.strip()
        lines.append(f"{n}\n{fmt_ts(s.start)} --> {fmt_ts(s.end)}\n{text}\n")
        print(f"[{n:>4}] {fmt_ts(s.start)}  {text}")

    with open(out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    dur = getattr(info, "duration", 0) or 0
    print(f"\n完成：{out}")
    print(f"共 {n} 条字幕；媒体时长 {dur:.1f}s，转写耗时 {time.time() - t0:.1f}s"
          + (f"（约 {dur / max(time.time() - t0, 0.01):.2f}× 实时）" if dur else ""))


if __name__ == "__main__":
    main()
