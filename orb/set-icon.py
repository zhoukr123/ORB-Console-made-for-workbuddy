#!/usr/bin/env python3
"""把任意一张图片设为 orb 的图标。

用法（用托管 Python 运行）：
    %USERPROFILE%/.workbuddy/binaries/python/envs/default/Scripts/python.exe set-icon.py <图片路径>

生成到 orb 的三处图标位（三处都用同一个文件，改完重启即生效）：
    desktop/icon.png     512x512   托盘图标 + 桌面球体 + 面板头像
    desktop/icon-64.png     64x64   备用尺寸
    icon.png             512x512   托盘回退路径（main.js 里的 ../icon.png）

首次运行会把被覆盖的原图标备份到 .icon-backup/。
"""
import os
import shutil
import sys

from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.abspath(__file__))
BAK = os.path.join(ROOT, ".icon-backup")


def backup(rel_path):
    p = os.path.join(ROOT, rel_path)
    if not os.path.exists(p):
        return
    os.makedirs(BAK, exist_ok=True)
    dst = os.path.join(BAK, os.path.basename(p) + ".bak")
    if not os.path.exists(dst):
        shutil.copy2(p, dst)
        print("  备份 %-20s -> %s" % (rel_path, dst))


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    src_path = sys.argv[1]
    src = Image.open(src_path).convert("RGBA")

    big = src.resize((512, 512), Image.LANCZOS)
    # 小图放大时轻微锐化，卡通/扁平图边缘更挺
    if max(src.size) < 256:
        big = big.filter(ImageFilter.UnsharpMask(radius=2.5, percent=55, threshold=2))
    small = src if src.size == (64, 64) else src.resize((64, 64), Image.LANCZOS)

    for rel, img in (
        ("desktop/icon.png", big),
        ("icon.png", big),
        ("desktop/icon-64.png", small),
    ):
        backup(rel)
        img.save(os.path.join(ROOT, rel))
        print("  写入 %-20s %s" % (rel, img.size))

    print("完成。重启 orb 后生效。")


if __name__ == "__main__":
    main()
