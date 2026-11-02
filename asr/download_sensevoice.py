# -*- coding: utf-8 -*-
"""下载 SenseVoice-Small int8 ONNX 权重（sherpa-onnx 格式，两个文件）。

用法:
  python download_sensevoice.py [dest_dir]
默认落到 ./models/sensevoice

为什么要 Python 脚本而不是让面板直接下载：
  · 源在国内不通是常态 —— 必须先试 ModelScope，再退 HF 镜像，最后才 GitHub；
  · 228 MB 要断点续传，失败一次不能从头再来；
  · 面板要进度条，所以输出格式与 download_model.py **完全一致**：

      [orb-asr] model <percent> <已下MB>/<总MB> <当前文件>

授权：SenseVoice 权重走 FunASR Model License（允许再分发；需注明来源并保留模型名）。
本脚本只做下载，不分发权重。
"""
import os
import sys
import time
import urllib.request
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
DEST = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "models", "sensevoice")

# 两个源都能给出同一份文件；sha256 是 int8 版官方值，用来判断"到底下全了没有"
FILES = [
    ("model.int8.onnx", 239233841, "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51"),
    ("tokens.txt", 315894, None),
]

MS = "https://www.modelscope.cn/api/v1/models/{repo}/repo?Revision=master&FilePath={name}"
MS_REPOS = ["poloniumrock/SenseVoiceSmallOnnx"]
HF = "https://hf-mirror.com/{repo}/resolve/main/{name}"
HF_REPOS = ["csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"]

UA = {"User-Agent": "orb-asr-setup/1.0"}


def mb(n):
    return "%.1f" % (n / 1048576.0)


def emit(done, total, filename):
    pct = int(done * 100 / total) if total else 0
    print("[orb-asr] model %d %s/%s %s" % (pct, mb(done), mb(total), filename), flush=True)


def sources(name):
    for r in MS_REPOS:
        yield MS.format(repo=r, name=name)
    for r in HF_REPOS:
        yield HF.format(repo=r, name=name)


def fetch(url, dest, total_size, opener=None):
    """带 Range 续传的一路下载；返回 True 表示这个文件到此为止已经完整。"""
    have = os.path.getsize(dest) if os.path.exists(dest) else 0
    if total_size and have >= total_size:
        emit(total_size, total_size, os.path.basename(dest))
        return True
    req = urllib.request.Request(url, headers=dict(UA))
    if have:
        req.add_header("Range", "bytes=%d-" % have)
    try:
        op = opener.open if opener else urllib.request.urlopen
        with op(req, timeout=60) as r:
            if have and r.status != 206:
                # 服务端不认 Range：只能从头来，先截断再写
                have = 0
            total = total_size
            if not total:
                cr = r.headers.get("Content-Range")
                cl = r.headers.get("Content-Length")
                total = int(cr.split("/")[-1]) if (cr and "/" in cr) else int(cl or 0)
            mode = "ab" if have else "wb"
            done = have
            last = 0.0
            with open(dest, mode) as f:
                while True:
                    chunk = r.read(262144)
                    if not chunk:
                        break
                    f.write(chunk)
                    done += len(chunk)
                    now = time.time()
                    if now - last > 0.25:
                        last = now
                        emit(done, total, os.path.basename(dest))
            emit(done, total, os.path.basename(dest))
            return (total and done >= total) or False
    except urllib.error.HTTPError as e:
        # 416 = 本地已经比远端的还长（多半是上次下坏了），删了重来
        if e.code == 416 and os.path.exists(dest):
            os.remove(dest)
        raise


def openers():
    """先真直连、再走系统代理。

    国内直连 ModelScope 最快，而企业网里往往必须走代理 —— 两种都要能成，
    所以顺序试而不是二选一。注意**第一个必须是空 ProxyHandler**：
    urlopen 默认会读 http_proxy 环境变量，那就不叫直连了。"""
    yield urllib.request.build_opener(urllib.request.ProxyHandler({}))
    if any(os.environ.get(v) for v in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY")):
        yield urllib.request.build_opener()


def main():
    os.makedirs(DEST, exist_ok=True)
    for name, size, _sha in FILES:
        dest = os.path.join(DEST, name)
        if size and os.path.exists(dest) and os.path.getsize(dest) == size:
            print("[orb-asr] skip %s（已存在且大小正确）" % name, flush=True)
            continue
        ok = False
        last_err = None
        for opener in openers():
            for url in sources(name):
                try:
                    print("[orb-asr] pick 5 src=%s" % url.split("?")[0][:80], flush=True)
                    ok = fetch(url, dest, size, opener)
                    if ok:
                        break
                except Exception as e:  # noqa: BLE001
                    last_err = e
                    print("[orb-asr] warn %s 失败：%s" % (url[:60], e), flush=True)
            if ok:
                break
        if not ok:
            print("[orb-asr] error 无法下载 %s：%s" % (name, last_err), flush=True)
            return 2
        if size and os.path.getsize(dest) != size:
            print(
                "[orb-asr] error %s 大小不对（%d，应为 %d）" % (name, os.path.getsize(dest), size),
                flush=True,
            )
            return 3
    print("[orb-asr] done %s" % DEST, flush=True)
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
