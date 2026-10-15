# -*- coding: utf-8 -*-
"""
ORB 本地离线语音识别服务（OpenAI 兼容）

- POST /v1/audio/transcriptions   multipart/form-data: file[, model, language]
- GET  /health

用 faster-whisper(ctranslate2) 做推理，默认 **small + 自动设备**。
- 换模型：环境变量 `ORB_ASR_MODEL_NAME`（small / medium …）或 `ORB_ASR_MODEL`（绝对路径）
- 换设备/精度：`ORB_ASR_DEVICE`（auto / cpu / cuda）、`ORB_ASR_COMPUTE`（auto / int8 / float16 …）
  · device=auto：探测 ctranslate2 是否带 CUDA，有则 cuda、无则 cpu（探测很轻，不写回配置）
  · 显式指定了 GPU 但起不来 → **自动回落 cpu/int8 并把生效值写回 asr.conf**，
    否则无显卡的机器每次重启都要先炸一次（见 resolve_device_compute）
供 ORB 语音模块（引擎=whisper / auto）调用；端点填 http://127.0.0.1:19876/v1/audio/transcriptions
"""
import os
import re
import json
import tempfile
import logging
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent


# ---- 配置：asr.conf（供 ORB 面板切换 CPU/GPU）+ 环境变量覆盖 ----
_CONF_FILE = HERE / "asr.conf"


def _read_conf() -> dict:
    try:
        return json.loads(_CONF_FILE.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}


def _write_conf(patch: dict) -> dict:
    """把生效值合并写回 asr.conf（回落 CPU 后必须落盘，见 resolve_device_compute）。"""
    try:
        next_cfg = {**_read_conf(), **(patch or {})}
        _CONF_FILE.write_text(json.dumps(next_cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return next_cfg
    except Exception as e:
        log.warning("写回 asr.conf 失败: %s", e)
        return _read_conf()


_CFG = _read_conf()

# 默认 small：medium 权重约 1.5GB、首轮加载慢一倍，对"能 offline 用"这个目标没有质变；
# 想换模型改 asr.conf 的 model 字段或 ORB_ASR_MODEL_NAME。
_MODEL_NAME = (os.environ.get("ORB_ASR_MODEL_NAME") or _CFG.get("model") or "small").strip()
_LOCAL_BASE = HERE / "models"


def _short_path(s: str) -> str:
    """Windows 8.3 短路径（GetShortPathNameW）。拿不到返回空串。"""
    try:
        import ctypes

        buf = ctypes.create_unicode_buffer(32768)
        n = ctypes.windll.kernel32.GetShortPathNameW(s, buf, 32768)
        if n and buf.value and all(ord(c) < 128 for c in buf.value):
            return buf.value
    except Exception:
        pass
    return ""


def _ascii_link_base() -> Path:
    """给 ctranslate2 用的 ASCII 目录：优先 %LOCALAPPDATA%\\orb-asr-models；
    用户名含中文时用 LOCALAPPDATA 的 8.3 短路径（C:\\Users\\张三 → C:\\Users\\ZHANGS~1）。
    目录名必须纯 ASCII —— 中文目录名本身就是 ctranslate2 认不下的东西。"""
    la = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    base = Path(la)
    try:
        str(base).encode("ascii")
    except UnicodeEncodeError:
        short = _short_path(str(base))
        if short:
            try:
                short.encode("ascii")
                base = Path(short)
            except UnicodeEncodeError:
                pass
    return base / "orb-asr-models"


def _junction_matches(link: Path, target: Path) -> bool:
    """联接存在、指向的就是 target、且目标里真有模型文件。
    断联接 / 指向别处（换过安装位置）/ 假联接都算不匹配，需要重建。"""
    try:
        return (
            link.is_dir()
            and (link / "model.bin").is_file()
            and link.resolve() == Path(target).resolve()
        )
    except OSError:
        return False


def _remove_link(link: Path) -> bool:
    """删掉联接本身（不动目标里的数据）。junction 用 rmdir、symlink 用 unlink。"""
    for fn in (lambda: link.unlink(), lambda: os.rmdir(link)):
        try:
            fn()
            return True
        except OSError:
            continue
    return False


def _ascii_model_path(real: Path) -> Path:
    """ctranslate2 在 Windows 上不认非 ASCII 路径（中文目录会 UnicodeDecodeError）。
    安装路径含非 ASCII 时，自动在 %LOCALAPPDATA% 下建**目录联接**（mklink /J，
    不需要管理员权限），返回 ASCII 路径；建不成就退回 8.3 短路径，再不行原样返回。
    （旧版本写死 D:\\orb-asr，开源后必须去掉。）"""
    s = str(real)
    try:
        s.encode("ascii")
        return real
    except UnicodeEncodeError:
        pass
    try:
        link = _ascii_link_base() / real.name
        link.parent.mkdir(parents=True, exist_ok=True)
        if not _junction_matches(link, real):
            # 从来没建过 / 建过但指向别处（安装位置变了）/ 断联接 —— 一律重建
            _remove_link(link)
            subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(link), str(real)],
                capture_output=True, timeout=15000, check=False,
            )
        if _junction_matches(link, real):
            return link
    except Exception:
        pass
    short = _short_path(s)
    return Path(short) if short else real


def _resolve_model(name: str) -> Path:
    """模型目录：asr/models/<name>（用户一键安装的落点）；ORB_ASR_MODEL 可直指绝对路径。"""
    env_dir = (os.environ.get("ORB_ASR_MODEL") or "").strip()
    if env_dir:
        return Path(env_dir)
    return _LOCAL_BASE / name


def models_available() -> list:
    """扫 asr/models/ 下已下全权重的模型名（含 model.bin 的目录），供 /health 报
    modelsAvailable；面板据此显示"已下载：small / medium"，引导用户切模型。"""
    out = []
    try:
        for child in sorted(_LOCAL_BASE.iterdir()):
            if child.is_dir() and (child / "model.bin").is_file():
                out.append(child.name)
    except OSError:
        pass
    return out


_DEFAULT_MODEL = _resolve_model(_MODEL_NAME)
if not (_DEFAULT_MODEL / "model.bin").is_file():   # 目标模型没就绪就回退 small
    _DEFAULT_MODEL = _resolve_model("small")
MODEL_DIR = _DEFAULT_MODEL
HOST = os.environ.get("ORB_ASR_HOST", "127.0.0.1")
PORT = int(os.environ.get("ORB_ASR_PORT", "19876"))
LANG = (os.environ.get("ORB_ASR_LANG") or _CFG.get("lang") or "zh")
LANG = LANG.strip() or None
# 优先简体：中文 / 自动检测时给一句普通话提示词，可显著把 Whisper 的中文输出拉向简体（否则常出繁体）。
# 设 ORB_ASR_PROMPT="" 可关闭。
PROMPT = os.environ.get("ORB_ASR_PROMPT", "以下是普通话的句子。")
# 热词/领域词：Whisper 的 initial_prompt 对专有名词极其敏感，
# 把课件/会议里的高频术语塞进来能明显减少同音错字（如"超星""智慧树""基因工程"）。
# 用法：ORB_ASR_HOTWORDS="超星,智慧树,基因工程,PCR"（逗号/顿号/空格分隔均可）
HOTWORDS = os.environ.get("ORB_ASR_HOTWORDS", "").strip()
# 设备/精度：asr.conf 或环境变量控制；GPU(cuda) 需先装 cuBLAS/cuDNN（nvidia-*-cu12）
DEVICE = (os.environ.get("ORB_ASR_DEVICE") or _CFG.get("device") or "auto").strip().lower()
COMPUTE = (os.environ.get("ORB_ASR_COMPUTE") or _CFG.get("compute") or "auto").strip().lower()


def build_prompt(lang, context=None):
    """拼 initial_prompt：简繁提示 + 热词 + 上一段上下文。

    Whisper 的 initial_prompt 会被当作"前文"来影响解码，所以塞术语最有效。
    只在中文（或自动检测）时启用；显式指定其它语言时不加，避免干扰。
    """
    if (lang or "").lower() not in ("", "zh"):
        return None
    parts = []
    if PROMPT:
        parts.append(PROMPT)
    if HOTWORDS:
        words = [w.strip() for w in re.split(r"[,，、\s]+", HOTWORDS) if w.strip()]
        if words:
            parts.append("可能出现的词：" + "、".join(words) + "。")
    if context:
        # 只取尾部：prompt 太长会挤占解码上下文，反而有害
        parts.append("上一段内容：" + str(context).strip()[-120:])
    return "".join(parts) if parts else None


def _prepare_cuda_dlls():
    """让 ctranslate2 能找到 pip 装的 cuBLAS/cuDNN DLL（nvidia-*-cu12 包在 site-packages/nvidia/*/bin）。
    Windows 上 ct2 不会自动去那里找，必须显式加进 DLL 搜索目录 + PATH。"""
    if DEVICE not in ("cuda", "auto"):
        return
    import sys

    roots = []
    try:
        import site

        roots += list(site.getsitepackages())
        roots.append(site.getusersitepackages())
    except Exception:
        pass
    roots += [p for p in sys.path if p.endswith("site-packages")]
    seen = set()
    for root in roots:
        nv = Path(root) / "nvidia"
        if not nv.is_dir():
            continue
        for sub in nv.iterdir():
            for d in (sub / "bin", sub / "lib"):
                if d.is_dir() and str(d) not in seen:
                    seen.add(str(d))
                    try:
                        os.add_dll_directory(str(d))
                    except Exception:
                        pass
                    os.environ["PATH"] = str(d) + os.pathsep + os.environ.get("PATH", "")

logging.basicConfig(level=logging.INFO, format="%(asctime)s [orb-asr] %(message)s")
log = logging.getLogger("orb-asr")

# GPU 时先把 cuBLAS/cuDNN 的 DLL 目录加进来（必须在 import ctranslate2 之前）
_prepare_cuda_dlls()

from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import JSONResponse
from faster_whisper import WhisperModel


# ─────────────────── 设备/精度解析（auto + 回落写回） ───────────────────
def _cuda_supported() -> bool:
    """这个 ctranslate2 构建里有没有 CUDA 支持（随包/venv 没装 nvidia-cu12 运行时就没有）。

    注意判定方式：get_supported_compute_types("cuda") 返回的是**计算类型集合**
    （{'int8','float16',...}），不带 CUDA 的构建返回**空集**（或抛异常）——
    所以"非空即支持"，不能按字面找 "cuda" 字符串。"""
    try:
        import ctranslate2

        types = ctranslate2.get_supported_compute_types("cuda")
        return bool(types) and len(types) > 0
    except Exception:
        return False


def _auto_compute(device: str) -> str:
    """compute=auto 时的取值：cuda→float16（不支持就沿 int8_float16→int8 逐级降），cpu→int8。"""
    if device != "cuda":
        return "int8"
    try:
        import ctranslate2

        sup = {str(t).lower() for t in ctranslate2.get_supported_compute_types("cuda")}
    except Exception:
        sup = set()
    for c in ("float16", "int8_float16", "int8"):
        if not sup or c in sup:
            return c
    return "int8"


def resolve_device_compute():
    """把 conf/环境变量里的 device/compute（可能是 auto）解析成实际可用的组合。

    返回 (device, compute, requested, fell_back, reason)：
      · device=auto：探测 ctranslate2 是否带 CUDA，有则 cuda、无则 cpu。
        探测很轻且不会炸，**不写回配置** —— 用户以后装上显卡驱动，auto 会自动用上。
      · 显式指定 cuda 但 GPU 不可用 / 模型构造失败：回落 cpu/int8，并把生效值
        **写回 asr.conf**。不写回的话，无显卡机器每次重启都要先炸一次，
        面板读到的也会是"期望值"而不是"实际值"（DESIGN §5.3 验收项 1）。
      · compute=auto：cuda→float16（不支持则 int8_float16→float16→int8 逐级降），cpu→int8。
    """
    req_dev = (DEVICE or "auto").strip().lower()
    if req_dev not in ("auto", "cpu", "cuda"):
        req_dev = "auto"                     # 老配置里的怪值按 auto 处理，不让用户手工改配置才能用
    req_cmp = (COMPUTE or "auto").strip().lower()
    fell_back = False
    reason = ""

    device = req_dev
    if device == "auto":
        device = "cuda" if _cuda_supported() else "cpu"
        if device == "cpu":
            reason = "未检测到可用的 GPU（ctranslate2 无 CUDA 支持），使用 CPU"
    elif device == "cuda" and not _cuda_supported():
        device, compute, fell_back = "cpu", "int8", True
        reason = "GPU 不可用，已回落 CPU/int8"
        return device, compute, {"device": req_dev, "compute": req_cmp}, fell_back, reason

    compute = req_cmp
    if compute == "auto":
        compute = _auto_compute(device)
    return device, compute, {"device": req_dev, "compute": req_cmp}, fell_back, reason


DEVICE_EFF, COMPUTE_EFF, REQUESTED, FELL_BACK, FALL_REASON = resolve_device_compute()
MODEL_DOWNLOADED = (MODEL_DIR / "model.bin").is_file()

log.info("loading model: %s (%s/%s) ...", MODEL_DIR, DEVICE_EFF, COMPUTE_EFF)
_MODEL_ARG = MODEL_DIR          # 先落默认值：except 分支里也要引用（非 ASCII 路径转换后的）
try:
    _MODEL_ARG = _ascii_model_path(MODEL_DIR)
    if str(_MODEL_ARG) != str(MODEL_DIR):
        log.info("模型路径含非 ASCII，已通过目录联接转换为: %s", _MODEL_ARG)
    model = WhisperModel(str(_MODEL_ARG), device=DEVICE_EFF, compute_type=COMPUTE_EFF, num_workers=1)
except Exception as e:
    if DEVICE_EFF != "cpu":
        # GPU 路线（显式 cuda 或 auto 探到 cuda）构造失败：回落 CPU/int8 并写回配置
        log.warning("GPU 不可用，已回落 CPU/int8：%s", e)
        DEVICE_EFF, COMPUTE_EFF = "cpu", "int8"
        FELL_BACK, FALL_REASON = True, "GPU 不可用，已回落 CPU/int8"
        model = WhisperModel(str(_MODEL_ARG), device=DEVICE_EFF, compute_type=COMPUTE_EFF, num_workers=1)
    else:
        raise
log.info("model ready (%s/%s)", DEVICE_EFF, COMPUTE_EFF)
if FELL_BACK:
    # 只有"显式指定却被改写"才写回：auto 保持 auto，下次启动重新探测
    _write_conf({"device": DEVICE_EFF, "compute": COMPUTE_EFF})
    log.info("生效值已写回 asr.conf（device=%s, compute=%s）", DEVICE_EFF, COMPUTE_EFF)

app = FastAPI(title="ORB local ASR")


@app.get("/health")
def health():
    """就绪度契约（DESIGN §5.3）：
      requested  用户在 asr.conf 里填的期望值（可能是 auto）
      effective  实际生效值 + 是否发生过回落 + 原因（面板据此显示"GPU 不可用已回落 CPU"）
      ready      模型已加载、可以识别
      modelDownloaded 模型权重文件是否在位（没下权重时面板应引导一键安装）
      modelsAvailable 本地已下全权重的模型名列表（面板显示"已下载：small / medium"）
    """
    return {
        "ok": True,
        "ready": True,
        "model": str(MODEL_DIR),
        "modelDownloaded": MODEL_DOWNLOADED,
        "modelsAvailable": models_available(),
        "device": DEVICE_EFF,
        "compute": COMPUTE_EFF,
        "requested": REQUESTED,
        "effective": {"device": DEVICE_EFF, "compute": COMPUTE_EFF, "fellBack": FELL_BACK, "reason": FALL_REASON},
        "lang": LANG or "auto",
        "prompt": PROMPT or None,
    }


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model_name: str = Form(None, alias="model"),
    language: str = Form(None),
    beam_size: int = Form(5),
    # 上一段终稿文本：回灌进 initial_prompt，让术语/人名跨句保持一致（上下文回灌）
    context: str = Form(None),
):
    data = await file.read()
    if not data:
        return JSONResponse({"error": "empty audio"}, status_code=400)
    fn = (file.filename or "").lower()
    suffix = ".webm"
    if fn.endswith(".wav"):
        suffix = ".wav"
    elif fn.endswith(".mp4") or fn.endswith(".m4a"):
        suffix = ".mp4"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as f:
        f.write(data)
        tmp = f.name
    try:
        # language 优先级：请求参数 > 服务端默认；"auto"（或空）表示自动检测
        lang = (language or LANG or "").strip()
        if lang.lower() in ("auto", "detect"):
            lang = ""
        # 中文（或自动）时带上「优先简体 + 热词 + 上一段」提示词；显式指定其它语言时不加，避免干扰
        prompt = build_prompt(lang, context)
        segments, info = model.transcribe(
            tmp, language=(lang or None), initial_prompt=prompt, beam_size=beam_size, vad_filter=True
        )
        text = "".join(seg.text for seg in segments).strip()
        log.info("transcribed %dB (%s/%.2fs) -> %r", len(data), info.language, info.duration, text)
        return {"text": text}
    except Exception as e:  # noqa
        log.exception("transcribe failed")
        return JSONResponse({"error": str(e)}, status_code=500)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


if __name__ == "__main__":
    import uvicorn

    log.info("serving on http://%s:%d", HOST, PORT)
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
