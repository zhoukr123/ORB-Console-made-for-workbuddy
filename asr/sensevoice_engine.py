# -*- coding: utf-8 -*-
"""SenseVoice-Small 引擎（sherpa-onnx / int8 ONNX）：转写 + 情绪 + 声学事件。

为什么在 faster-whisper 之外再加一条引擎：
  · **快**：同一台机器 CPU 上实测 RTF 0.022~0.032（faster-whisper small/int8 是 0.2），
    30 倍以上的差距，1 小时音频从 12 分钟压到 20 秒级。
  · **一次前向出四样**：文字 / 语种 / 情绪（7 类）/ 声学事件（笑声、掌声、BGM、咳嗽…）。
    情绪是白拿的 —— 不需要再挂第二个模型。
  · **非自回归**：没有 whisper 的复读机 / 静音幻觉，长音频不会突然吐出重复句子。
  · 代价：模型 228 MB（int8）。对"离线优先"的定位是可以接受的。

授权：框架 MIT；SenseVoice 权重走 FunASR Model License（允许使用/复制/修改/**再分发**，
条件是注明来源并保留模型名，不带担保）。署名见 /health 的 `credits` 字段与关于页。

契约：`transcribe_wav()` 的返回结构与 whisper 版本**向后兼容** ——
`text` / `segments[{start,end,text}]` 一定在，`emotions` / `events` / `dominant` 是纯增量，
老的调用方（只读 text/segments）不需要改。
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path
from typing import List, Optional, Tuple

SAMPLE_RATE = 16000

# SenseVoice 的 7 类情绪 → 中文。标签原样来自模型输出的 <|HAPPY|> 这类 token。
EMOTION_ZH = {
    "NEUTRAL": "平静",
    "HAPPY": "高兴",
    "SAD": "低落",
    "ANGRY": "生气",
    "FEARFUL": "紧张",
    "DISGUSTED": "厌烦",
    "SURPRISED": "惊讶",
}
# 模型只会给这几类，其它一律按 NEUTRAL 收口，避免脏标签漏进产物
_EMOTION_SET = set(EMOTION_ZH)

EVENT_ZH = {
    "Speech": "说话",
    "Laughter": "笑声",
    "Applause": "掌声",
    "BGM": "背景音乐",
    "Crying": "哭声",
    "Cough": "咳嗽",
    "Sneeze": "喷嚏",
    "Breath": "呼吸",
}


# ---------------------------------------------------------------- 路径处理
def _short_path(s: str) -> str:
    """Windows 8.3 短路径；拿不到返回空串。"""
    try:
        import ctypes

        buf = ctypes.create_unicode_buffer(32768)
        n = ctypes.windll.kernel32.GetShortPathNameW(s, buf, 32768)
        if n and buf.value and all(ord(c) < 128 for c in buf.value):
            return buf.value
    except Exception:
        pass
    return ""


def ascii_path(real: Path) -> Path:
    """onnxruntime 在 Windows 上对非 ASCII 路径并不总稳（中文目录会打不开模型）。
    安装路径含中文时在 %LOCALAPPDATA% 下建**目录联接**（mklink /J，不需要管理员）
    换一个纯 ASCII 路径；建不成退回 8.3 短路径，再不行原样返回。"""
    s = str(real)
    try:
        s.encode("ascii")
        return real
    except UnicodeEncodeError:
        pass
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    try:
        str(base).encode("ascii")
    except UnicodeEncodeError:
        short = _short_path(base)
        if short:
            base = short
    try:
        link = Path(base) / "orb-asr-models" / real.name
        link.parent.mkdir(parents=True, exist_ok=True)
        ok = False
        try:
            ok = link.is_dir() and link.resolve() == real.resolve()
        except OSError:
            ok = False
        if not ok:
            if link.exists() or link.is_symlink():
                try:
                    os.rmdir(link)
                except OSError:
                    try:
                        link.unlink()
                    except OSError:
                        pass
            subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(link), str(real)],
                capture_output=True,
                timeout=15000,
                check=False,
            )
        if link.is_dir():
            return link
    except Exception:
        pass
    short = _short_path(s)
    return Path(short) if short else real


# ---------------------------------------------------------------- 引擎本体
def _preload_onnxruntime() -> str:
    """抢在 sherpa_onnx 之前把我们自己的 onnxruntime.dll 装进进程。

    坑：Windows/system32 下另有一个 onnxruntime.dll（1.17.1，别家软件装的）。
    sherpa 的 pyd 里是 LoadLibrary("onnxruntime.dll")，system32 的搜索优先级高于
    site-packages，于是加载到旧版，直接抛
    "The requested API version [28] is not available, only API versions [1, 17]"。
    先 WinDLL 一份正确路径 —— 模块名已被占用，后面的加载会复用这个句柄。"""
    try:
        import ctypes

        import onnxruntime as _ort

        dll = Path(_ort.__file__).parent / "capi" / "onnxruntime.dll"
        if not dll.is_file():
            return ""
        try:
            os.add_dll_directory(str(dll.parent))
        except Exception:
            pass
        ctypes.WinDLL(str(dll))
        return str(dll)
    except Exception as e:  # noqa: BLE001
        print("orb-asr: 预加载 onnxruntime 失败 %r" % (e,), file=sys.stderr)
        return ""


def find_model_dir(root: Path) -> Optional[Path]:
    """在 asr/models/ 下找一份可用的 SenseVoice（要同时有 onnx 与 tokens）。"""
    cands: List[Path] = []
    env = (os.environ.get("ORB_ASR_SENSEVOICE") or "").strip()
    if env:
        cands.append(Path(env))
    cands.append(root / "sensevoice")
    for d in cands:
        if (d / "tokens.txt").is_file() and (
            (d / "model.int8.onnx").is_file() or (d / "model.onnx").is_file()
        ):
            return d
    return None


class SenseVoiceEngine:
    """离线转写 + 情绪。线程不安全（sherpa 的 recognizer 不是线程安全的），
    调用方（asr_server 的线程池）自己保证串行。"""

    name = "sensevoice"
    credits = (
        "语音识别与情感识别由 FunASR / SenseVoice 提供"
        "（阿里巴巴通义实验室，MIT + FunASR Model License）"
    )

    def __init__(self, model_dir: Path, num_threads: int = 4, language: str = "auto"):
        _preload_onnxruntime()
        import sherpa_onnx  # 延迟导入：没装 sherpa-onnx 时 asr_server 还能用 whisper

        self.model_dir = model_dir
        mpath = ascii_path(model_dir)
        model = mpath / ("model.int8.onnx" if (mpath / "model.int8.onnx").is_file() else "model.onnx")
        tokens = mpath / "tokens.txt"
        t0 = time.time()
        self.rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=str(model),
            tokens=str(tokens),
            num_threads=max(1, int(num_threads or 1)),
            use_itn=True,             # 逆文本正则化：数字、标点更像人写的
            language=(language or "auto"),
            debug=False,
        )
        self.load_sec = round(time.time() - t0, 2)
        self.model_name = "sensevoice-small-int8"

    # -------------------------------------------------- 解码
    @staticmethod
    def decode_audio(path: Path) -> "object":
        """任意容器 → 16k 单声道 float32。用 PyAV（venv 自带），不依赖外部 ffmpeg。"""
        import av
        import numpy as np

        with av.open(str(path)) as c:
            if not c.streams.audio:
                raise RuntimeError("这个文件里没有音轨")
            st = c.streams.audio[0]
            rs = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
            chunks = []
            for frame in c.decode(st):
                for out in rs.resample(frame):
                    chunks.append(out.to_ndarray().reshape(-1))
            for out in rs.resample(None):
                chunks.append(out.to_ndarray().reshape(-1))
        if not chunks:
            return np.zeros(0, dtype=np.float32)
        pcm = np.concatenate(chunks).astype(np.int16)
        return pcm.astype(np.float32) / 32768.0

    # -------------------------------------------------- 能量 VAD
    @staticmethod
    def energy_vad(
        x,
        frame_ms: int = 20,
        min_sil: float = 0.28,
        min_speech: float = 0.22,
        max_seg: float = 24.0,
    ) -> List[Tuple[float, float]]:
        """按短时能量切句。零依赖、零模型 —— 对录屏 / 会议 / 课程录音够用。

        阈值不是写死的 dB，而是**相对噪声底**：取全片 15 分位当作底噪，
        高于底噪 10 dB 才算有声。这样同一套参数能同时应付安静的录屏和
        底噪很大的现场录音。"""
        import numpy as np

        hop = int(SAMPLE_RATE * frame_ms / 1000)
        if hop <= 0 or len(x) < hop * 4:
            return [(0.0, max(0.0, len(x) / SAMPLE_RATE))] if len(x) else []

        n = len(x) // hop
        frames = x[: n * hop].reshape(n, hop).astype(np.float32)
        rms = np.sqrt(np.mean(frames * frames, axis=1) + 1e-12)
        db = 20.0 * np.log10(rms + 1e-12)

        floor_db = float(np.percentile(db, 15))
        thresh = max(floor_db + 10.0, -48.0)
        voiced = db > thresh

        # 膨胀 3 帧再腐蚀 1 帧：把词尾的弱音补回来，又不至于把静音拉长
        def _dilate(a, k):
            if k <= 1 or len(a) == 0:
                return a
            pad = np.pad(a.astype(np.int8), (k // 2, k - 1 - k // 2), mode="edge")
            win = np.ones(k, dtype=np.int8)
            return np.convolve(pad, win, mode="valid") > 0

        voiced = _dilate(voiced, 3)

        segs: List[Tuple[float, float]] = []
        i = 0
        gap = int(min_sil * 1000 / frame_ms)
        while i < n:
            if not voiced[i]:
                i += 1
                continue
            start = i
            last = i
            while i < n:
                if voiced[i]:
                    last = i
                    i += 1
                    if (i - start) * frame_ms / 1000.0 >= max_seg:
                        break
                else:
                    if i - last >= gap:
                        break
                    i += 1
            t0 = start * frame_ms / 1000.0
            t1 = (last + 1) * frame_ms / 1000.0
            if t1 - t0 >= min_speech:
                segs.append((t0, t1))
        return segs

    # -------------------------------------------------- 主入口
    def transcribe_samples(self, samples, language: str = "", context: str = None) -> dict:
        t_start = time.time()
        dur = len(samples) / float(SAMPLE_RATE)
        segs = self.energy_vad(samples)

        out_segs: List[dict] = []
        emotion_count: dict = {}
        event_count: dict = {}
        lang_votes: dict = {}
        texts: List[str] = []

        for (a, b) in segs:
            i0 = max(0, int(a * SAMPLE_RATE))
            i1 = min(len(samples), int(b * SAMPLE_RATE))
            if i1 - i0 < int(0.15 * SAMPLE_RATE):
                continue
            st = self.rec.create_stream()
            st.accept_waveform(SAMPLE_RATE, samples[i0:i1])
            self.rec.decode_stream(st)
            r = st.result
            text = (getattr(r, "text", "") or "").strip()
            emo = _clean_tag(getattr(r, "emotion", ""))
            ev = _clean_tag(getattr(r, "event", ""))
            lg = _clean_tag(getattr(r, "lang", ""))
            if emo not in _EMOTION_SET:
                emo = "NEUTRAL" if emo else ""
            if not text and not emo:
                continue
            seg = {
                "start": round(a, 2),
                "end": round(b, 2),
                "text": text,
                "emotion": emo,
                "emotionZh": EMOTION_ZH.get(emo, ""),
                "event": ev,
            }
            out_segs.append(seg)
            if text:
                texts.append(text)
            if emo:
                emotion_count[emo] = emotion_count.get(emo, 0) + 1
            if ev:
                event_count[ev] = event_count.get(ev, 0) + 1
            if lg:
                lang_votes[lg] = lang_votes.get(lg, 0) + 1

        dominant = ""
        if emotion_count:
            dominant = max(emotion_count.items(), key=lambda kv: kv[1])[0]
        lang = max(lang_votes.items(), key=lambda kv: kv[1])[0] if lang_votes else ""

        return {
            "text": "".join(texts).strip(),
            "segments": out_segs,
            "engine": self.name,
            "model": self.model_name,
            "lang": lang,
            "audioSec": round(dur, 2),
            "elapsedSec": round(time.time() - t_start, 2),
            "rtf": round((time.time() - t_start) / max(dur, 1e-6), 4),
            "emotions": emotion_count,
            "emotionsZh": {EMOTION_ZH.get(k, k): v for k, v in emotion_count.items()},
            "dominant": dominant,
            "dominantZh": EMOTION_ZH.get(dominant, ""),
            "events": event_count,
            "eventsZh": {EVENT_ZH.get(k, k): v for k, v in event_count.items()},
            "credits": self.credits,
        }

    def transcribe_wav(self, path: Path, language: str = "", context: str = None) -> dict:
        return self.transcribe_samples(self.decode_audio(Path(path)), language=language, context=context)


def _clean_tag(v) -> str:
    """<|HAPPY|> → HAPPY；<|zh|> → zh；<|Speech|> → Speech。"""
    s = str(v or "").strip()
    if s.startswith("<|") and s.endswith("|>"):
        s = s[2:-2]
    return s.strip()
