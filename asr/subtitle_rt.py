# -*- coding: utf-8 -*-
r"""
ORB 实时字幕：抓【系统正在播放的声音】(WASAPI loopback) → 静音切段 → 本地 Whisper → 实时上屏。

- 打开 http://127.0.0.1:19879  实时看字幕（新句子自动出现）
- GET /srt                      随时下载本次累积的 .srt
- 模型/端点复用 19876 的识别服务（GPU 上约 1s 一段）

启动: asr\venv\Scripts\python.exe asr\subtitle_rt.py
"""
import asyncio
import io
import json
import os
import queue
import threading
import time
import wave
from pathlib import Path

import numpy as np
import pyaudiowpatch as pyaudio
import requests
from fastapi import FastAPI, Response
from fastapi.responses import HTMLResponse, StreamingResponse

HERE = Path(__file__).resolve().parent
ASR = os.environ.get("ORB_ASR_ENDPOINT", "http://127.0.0.1:19876/v1/audio/transcriptions")
PORT = int(os.environ.get("ORB_RT_PORT", "19879"))
IN_RATE = 48000          # 回环设备采样率
TARGET = 16000           # whisper 需要 16k
FRAME = 1024             # 每次采集的帧数
RMS_GATE = float(os.environ.get("ORB_RT_GATE", "180"))   # 语音门限（int16 RMS）
MIN_SPEECH = 1.0         # 一段至少这么长（秒）才送去识别
TAIL_SIL = 0.45          # 静音这么久就切一段（原 0.7s，压缩端到端延迟）
MAX_SPEECH = 12.0        # 一段最长（秒）（原 18s，避免长句迟迟不出）
PARTIAL_EVERY = 1.6      # 说话中每这么久（秒）出一次「草稿」
PARTIAL_BEAM = 1         # 草稿用贪心解码（快），终稿仍用 beam=5
PARTIAL_MIN_NEW = 1.2    # 距上次草稿至少新增这么长的语音才重新出草稿

results: list = []       # [(idx, start, end, text)]
partial = {"text": "", "at": 0.0}   # 当前正在说话的草稿
lock = threading.Lock()
running = True
srt_base = 0.0           # 本次会话的时间起点

# 字幕存缓存目录（便于整体清理；可改环境变量 ORB_RT_SRT_DIR）；文件名 = 会话启动时间。
# 默认值由桥在拉起本进程时用 ORB_RT_SRT_DIR 指定（DATA_DIR/.cache/实时字幕，
# 开发态是项目根、打包态是 %APPDATA%\ORB 控制台）—— 所以这里只留一个
# **不含任何机器私有路径**的兜底：脚本所在目录下的 .cache。
# （历史上这里写死过开发机的私有路径，开源后已移除。）
SRT_DIR = Path(os.environ.get("ORB_RT_SRT_DIR") or (Path(__file__).resolve().parent / ".cache" / "实时字幕"))
SRT_FILE = SRT_DIR / ("实时字幕-" + time.strftime("%Y%m%d-%H%M%S") + ".srt")


def persist_srt():
    """把累积字幕写盘（每次出新句子都刷新一次）。"""
    try:
        SRT_DIR.mkdir(parents=True, exist_ok=True)
        SRT_FILE.write_text(make_srt(), encoding="utf-8")
    except Exception as e:
        log("写字幕文件失败:", e)

log = lambda *a: print("[rt]", *a, flush=True)

# ---------------- 采集线程：回环 -> 16k 单声道 -> 静音切段 ----------------
audio_q: "queue.Queue[bytes]" = queue.Queue(maxsize=64)


def pcm_resample(frame: bytes, ch: int) -> np.ndarray:
    """int16 立体声 PCM -> float32 16k 单声道。
    注意：不做任何归一化——电平信息要留给 VAD 门限判断（逐帧归一会让静音也变满幅）。"""
    a = np.frombuffer(frame, dtype=np.int16).astype(np.float32)
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1)
    a = a[::IN_RATE // TARGET]
    return a


def capture_loop():
    global running
    p = pyaudio.PyAudio()
    dev = None
    for i in range(p.get_device_count()):
        d = p.get_device_info_by_index(i)
        if d.get("isLoopbackDevice"):
            dev = d
            break
    if dev is None:
        log("找不到回环设备"); running = False; return
    rate = int(dev["defaultSampleRate"]) or IN_RATE
    log("loopback:", dev["name"], rate, "Hz")
    stream = p.open(format=pyaudio.paInt16, channels=int(dev["maxInputChannels"]) or 2,
                    rate=rate, input=True, input_device_index=dev["index"],
                    frames_per_buffer=FRAME)
    while running:
        try:
            data = stream.read(FRAME, exception_on_overflow=False)
        except Exception:
            break
        pcm = pcm_resample(data, int(dev["maxInputChannels"]) or 2)
        try:
            audio_q.put_nowait(pcm)
        except queue.Full:
            pass
    stream.stop_stream(); stream.close(); p.terminate()


def rms(a: np.ndarray) -> float:
    return float(np.sqrt(np.mean(a * a))) if a.size else 0.0


def worker_loop():
    """主循环：攒语音段 -> 说话中出「草稿」(partial) -> 句尾出终稿"""
    global running, srt_base
    buf = np.zeros(0, dtype=np.float32)     # 当前段
    sil = 0.0                               # 已静音时长
    speech = 0.0                            # 已有语音时长（段内最近一次有声的位置）
    last_partial_end = 0.0                  # 上次草稿覆盖到的位置（段内秒数）
    partial_busy = {"on": False}
    dbg_n = 0
    dbg_peak = 0.0
    while running:
        try:
            a = audio_q.get(timeout=0.2)
        except queue.Empty:
            a = None
        if a is not None:
            buf = np.concatenate([buf, a]) if buf.size else a
        dur = buf.size / TARGET
        r = rms(a) if a is not None else 0.0
        if os.environ.get("ORB_RT_DEBUG") == "1":
            dbg_n += 1
            dbg_peak = max(dbg_peak, r)
            if dbg_n % 200 == 0:
                log(f"dbg queue={audio_q.qsize()} dur={dur:.1f}s peakRMS={dbg_peak:.0f} lastRMS={r:.0f} speech={speech:.1f}")
                dbg_peak = 0.0
        if r >= RMS_GATE:
            speech = dur; sil = 0.0
        else:
            sil += (a.size / TARGET) if a is not None else 0.2
        # 说话中出草稿：攒够新增语音且识别线程空闲，就先用贪心解码出个大概
        if (speech - last_partial_end) >= PARTIAL_MIN_NEW and speech >= MIN_SPEECH:
            last_partial_end = speech
            fire_partial(buf[: int(speech * TARGET)].copy(), partial_busy)
        cut = (sil >= TAIL_SIL and speech >= MIN_SPEECH) or (dur >= MAX_SPEECH)
        if not cut:
            continue
        # 切一段（去掉尾部静音），送终稿识别
        seg = buf[: int(max(dur - sil, MIN_SPEECH) * TARGET)]
        buf = np.zeros(0, dtype=np.float32)
        last_partial_end = 0.0
        with lock:
            partial["text"] = ""; partial["at"] = 0.0
        t_start, t_end = srt_base, srt_base + (seg.size / TARGET)
        srt_base = t_end
        threading.Thread(target=transcribe, args=(seg.copy(), t_start, t_end), daemon=True).start()


def fire_partial(seg: np.ndarray, busy: dict):
    """说话中先把「至今为止」的音频用贪心解码出草稿（低延迟）；busy 防重入。"""
    if busy["on"]:
        return
    busy["on"] = True

    def run():
        try:
            b = io.BytesIO()
            w = wave.open(b, "wb")
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(TARGET)
            w.writeframes((np.clip(seg, -32768, 32767)).astype(np.int16).tobytes())
            w.close()
            r = requests.post(ASR + "", files={"file": ("partial.wav", b.getvalue(), "audio/wav")},
                              data={"beam_size": str(PARTIAL_BEAM)}, timeout=60)
            text = (r.json() or {}).get("text", "").strip()
            if text:
                with lock:
                    partial["text"] = text; partial["at"] = time.time()
                log("草稿:", text[:40])
        except Exception:
            pass
        finally:
            busy["on"] = False

    threading.Thread(target=run, daemon=True).start()


def transcribe(seg: np.ndarray, t_start: float, t_end: float):
    """把一段音频 POST 给本地识别服务，结果上屏 + 累积 SRT"""
    try:
        b = io.BytesIO()
        w = wave.open(b, "wb")
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(TARGET)
        w.writeframes((np.clip(seg, -32768, 32767)).astype(np.int16).tobytes())
        w.close()
        # 上下文回灌：把「上一段终稿」带给服务端，拼进 initial_prompt，
        # 让术语/人名跨句保持一致（服务端只在中文时启用，且只取尾部 120 字）。
        with lock:
            prev = results[-1][3] if results else ""
        data = {"context": prev} if prev else {}
        r = requests.post(ASR, files={"file": ("chunk.wav", b.getvalue(), "audio/wav")},
                          data=data, timeout=120)
        text = (r.json() or {}).get("text", "").strip()
    except Exception as e:
        log("识别失败:", e); return
    if not text:
        return
    with lock:
        results.append([len(results) + 1, t_start, t_end, text])
    log(f"{t_start:6.1f}s  {text}")
    persist_srt()
    if len(results) > 400:
        del results[: len(results) - 400]


def make_srt() -> str:
    out = []
    with lock:
        items = list(results)
    for i, (idx, a, b, t) in enumerate(items, 1):
        f = lambda x: f"{int(x // 3600):02d}:{int((x % 3600) // 60):02d}:{x % 60:06.3f}".replace(".", ",")
        out.append(f"{i}\n{f(a)} --> {f(b)}\n{t}\n")
    return "\n".join(out)


app = FastAPI(title="ORB 实时字幕")
PAGE = """<!doctype html><meta charset=utf-8><title>ORB 实时字幕</title>
<style>body{background:#111;color:#eee;font:15px/1.6 system-ui,'Segoe UI',sans-serif;max-width:760px;margin:0 auto;padding:18px}
.line{padding:4px 8px;margin:2px 0;border-radius:8px;background:#1c1c22}
.line:last-child{background:#233;color:#9ecbff}
.partial{opacity:.65;font-style:italic}
h1{font-size:16px;color:#9ecbff}.srt{font-size:12px;color:#888;cursor:pointer}</style>
<h1>ORB 实时字幕 <span class="srt" id="srt">复制 SRT</span> <span class="srt" id="dl">下载 SRT</span></h1>
<div id="out">（等系统有声音就开始出字…）</div>
<script>
let n=0; const lines=[]; let PD='';
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function draw(){
  let h=lines.map(x=>'<div class=line>'+esc(x)+'</div>').join('');
  if(PD)h+='<div class=line partial>'+esc(PD)+' …</div>';
  document.getElementById('out').innerHTML=h||'（等系统有声音就开始出字…）';
}
/* SSE 取代原来的 setInterval(pull,500)：服务端有新句子才推，空请求归零。
   注意 items 是**当前窗口**（与 /lines 默认行为一致 = 尾部 8 条），
   每帧整表替换即可，客户端不需要自己攒、也不需要关心重连。 */
const es=new EventSource('/events');
es.onmessage=e=>{try{const d=JSON.parse(e.data);n=d.total;
  lines=d.items.map(it=>it.text);
  PD=d.partial||''; draw();
}catch(err){}};
es.onerror=()=>{ /* EventSource 会自动重连，这里只占位 */ };
document.getElementById('srt').onclick=()=>fetch('/srt').then(r=>r.text()).then(t=>navigator.clipboard.writeText(t));
document.getElementById('dl').onclick=()=>location.href='/srt';
</script>"""


@app.get("/")
def page():
    return HTMLResponse(PAGE)


@app.get("/lines")
def lines_(frm: int = 0):
    with lock:
        items = [{"idx": i, "text": t} for (i, a, b, t) in results if i > (frm or 0)]
        total = len(results)
        cur = dict(partial)
    return {"total": total, "items": items[-8:], "partial": cur.get("text") or ""}


@app.get("/events")
async def events():
    """SSE：有新句子或草稿变化就推一条，空闲只发心跳注释。

    为什么加这个：客户端原来是 setInterval 轮询 /lines（面板侧 900ms、页面侧 500ms），
    绝大多数请求是空跑。字幕本来就是"来了就显示"的场景，服务端推送更合适，
    而且延迟从"最多一个轮询周期"降到"几乎实时"。

    **协议与 /lines 的默认行为逐字段一致**：data 行是同一个 JSON
    （total / items / partial），items 是尾部 8 条的**窗口快照**，不是增量。
    这样客户端可以完全无状态 —— 每帧整表替换即可，重连也不用重置缓存。

    （曾经写成增量推送，结果两个客户端语义分叉：内置页面自己攒窗口，
     而 Electron 悬浮窗 subtitle.html 是按整表替换的，只会显示最新一条、
     丢掉前一条。改成窗口快照后两边都对，且与 /lines 的契约真正统一。）
    """
    async def gen():
        last_total = -1
        last_partial = ""
        while True:
            with lock:
                window = [{"idx": i, "text": t} for (i, a, b, t) in results[-8:]]
                total = len(results)
                cur = dict(partial)
            ptxt = cur.get("text") or ""
            if total != last_total or ptxt != last_partial:
                last_total = total
                last_partial = ptxt
                payload = json.dumps(
                    {"total": total, "items": window, "partial": ptxt},
                    ensure_ascii=False,
                )
                yield f"data: {payload}\n\n"
            else:
                # 心跳注释：防止中间层把空闲连接断掉
                yield ": ping\n\n"
            await asyncio.sleep(0.25)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            # 反向代理（nginx 等）默认会缓冲 SSE，加上这个头让它直通
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/srt")
def srt_():
    return Response(make_srt(), media_type="text/plain; charset=utf-8")


@app.get("/health")
def h():
    return {"ok": True, "capturing": running, "lines": len(results), "srt_file": str(SRT_FILE)}


if __name__ == "__main__":
    import uvicorn

    threading.Thread(target=capture_loop, daemon=True).start()
    threading.Thread(target=worker_loop, daemon=True).start()
    log(f"实时字幕页面: http://127.0.0.1:{PORT}")
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
