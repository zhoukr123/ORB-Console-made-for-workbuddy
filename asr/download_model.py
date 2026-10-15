# -*- coding: utf-8 -*-
"""下载 faster-whisper 模型权重（按文件逐个下，可断点续传、可打印百分比）。

用法:
  python download_model.py [repo_id] [dest_dir]
默认: Systran/faster-whisper-small -> ./models/small

下载源（DESIGN §5.2）：
  · ORB_ASR_HF_ENDPOINT 设了就用它（用户/企业内网镜像）；
  · 否则**先官方 huggingface.co，失败再 hf-mirror.com** ——
    反过来会让国外用户吃亏，且官方源支持断点续传更稳。
  · HF_HUB_DISABLE_TELEMETRY=1：不往 HuggingFace 发任何统计数据。

输出格式（面板/bridge 解析进度用）：
  [orb-asr] model <percent> <已下MB>/<总MB> <当前文件>
"""
import os
import sys

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

HERE = os.path.dirname(os.path.abspath(__file__))
repo = sys.argv[1] if len(sys.argv) > 1 else "Systran/faster-whisper-small"
dest = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "models", "small")

OFFICIAL = "https://huggingface.co"
MIRROR = "https://hf-mirror.com"


def endpoints():
    """下载源顺序：显式覆盖 > 官方 > 国内镜像。"""
    override = (os.environ.get("ORB_ASR_HF_ENDPOINT") or "").strip().rstrip("/")
    if override:
        return [override]
    return [OFFICIAL, MIRROR]


def mb(n):
    return "%.1f" % (n / 1048576.0)


def emit(done_bytes, total_bytes, filename):
    pct = int(done_bytes * 100 / total_bytes) if total_bytes else 0
    print("[orb-asr] model %d %s/%s %s" % (pct, mb(done_bytes), mb(total_bytes), filename), flush=True)


def main():
    from huggingface_hub import HfApi, hf_hub_download

    last_err = None
    for ep in endpoints():
        os.environ["HF_ENDPOINT"] = ep
        try:
            print("[orb-asr] pick 5 HF_ENDPOINT=%s" % ep, flush=True)
            api = HfApi(endpoint=ep)
            files = [f for f in api.list_repo_files(repo) if not f.endswith("/")]
            # 先探各文件大小，好按字节数算总进度（拿不到大小就按 0 计，不影响下载）
            sizes = {}
            total = 0
            for f in files:
                try:
                    meta = api.get_hf_file_metadata(repo, f)
                    sizes[f] = meta.size or 0
                except Exception:
                    sizes[f] = 0
                total += sizes[f]
            print("[orb-asr] pick 10 %d 个文件，合计 %s MB" % (len(files), mb(total)), flush=True)

            done = 0
            for f in files:
                dst = os.path.join(dest, f)
                if os.path.isfile(dst) and sizes[f] and os.path.getsize(dst) >= sizes[f]:
                    done += sizes[f]        # 已下完的跳过 → 断点续传
                    emit(done, total, f + " (已缓存)")
                    continue
                hf_hub_download(
                    repo_id=repo, filename=f, local_dir=dest,
                    resume_download=True,     # 中断的后半段接着下，不重头再来
                )
                try:
                    done += os.path.getsize(dst)
                except OSError:
                    done += sizes[f]
                emit(done, total, f)
            print("[orb-asr] done 100 模型已就绪: %s" % dest, flush=True)
            return 0
        except Exception as e:  # noqa
            last_err = e
            print("[orb-asr] warn 0 源 %s 失败（%s），尝试下一个源" % (ep, e), flush=True)
    print("[orb-asr] error 0 所有源都下载失败: %s" % last_err, flush=True)
    return 1


if __name__ == "__main__":
    print("downloading %s -> %s" % (repo, dest), flush=True)
    sys.exit(main())
