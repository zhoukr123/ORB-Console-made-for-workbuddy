/*
 * orb-input.exe —— Orb 的鼠标原语工具
 *
 * 为什么要有它：windows-mcp 只暴露了 Click（等价于 down+up 连发），
 * 没有 mousePress / mouseRelease 原语，所以「长按」「按住拖动」这类
 * 需要把按下和抬起拆开的操作做不了。这里用 Win32 SendInput 补齐。
 *
 * 另一个用途是速度：每次调用进程启动约 5ms，
 * 而 spawn PowerShell 完成同样的事要 200ms 量级。
 *
 * 坐标系：进程声明为 per-monitor DPI aware，因此所有坐标都是
 * 物理屏幕像素，与 windows-mcp 的 loc 参数同一坐标系。
 *
 * 用法：
 *   orb-input cursor
 *   orb-input move <x> <y>
 *   orb-input press <x> <y> [left|right|middle]
 *   orb-input release [left|right|middle]
 *   orb-input longpress <x> <y> <ms> [left|right|middle]
 *   orb-input drag <x1> <y1> <x2> <y2> [ms] [left|right|middle]
 *   orb-input scroll <x> <y> <up|down|left|right> [clicks]
 *
 * 约定：坐标为负数表示「不要移动光标，就地操作」。
 * 比如 press -1 -1 就是在鼠标当前位置按下，
 * 配合 release 可以手工实现按住不放。
 *
 * 输出：单行文本，退出码 0 表示成功。
 */

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
#define DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 ((DPI_AWARENESS_CONTEXT)-4)
#endif
#ifndef DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE
#define DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE ((DPI_AWARENESS_CONTEXT)-3)
#endif

typedef BOOL (WINAPI *SetDpiCtxFn)(DPI_AWARENESS_CONTEXT);

static void make_dpi_aware(void) {
    HMODULE user32 = LoadLibraryA("user32.dll");
    if (user32) {
        SetDpiCtxFn fn = (SetDpiCtxFn)GetProcAddress(user32, "SetProcessDpiAwarenessContext");
        if (fn) {
            if (fn(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) return;
            if (fn(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE)) return;
        }
    }
    SetProcessDPIAware();
}

static DWORD flag_down(const char *btn) {
    if (btn && _stricmp(btn, "right") == 0)  return MOUSEEVENTF_RIGHTDOWN;
    if (btn && _stricmp(btn, "middle") == 0) return MOUSEEVENTF_MIDDLEDOWN;
    return MOUSEEVENTF_LEFTDOWN;
}

static DWORD flag_up(const char *btn) {
    if (btn && _stricmp(btn, "right") == 0)  return MOUSEEVENTF_RIGHTUP;
    if (btn && _stricmp(btn, "middle") == 0) return MOUSEEVENTF_MIDDLEUP;
    return MOUSEEVENTF_LEFTUP;
}

static void send_button(DWORD flag, DWORD mouseData) {
    INPUT in;
    memset(&in, 0, sizeof(in));
    in.type = INPUT_MOUSE;
    in.mi.dwFlags = flag;
    in.mi.mouseData = mouseData;
    SendInput(1, &in, sizeof(INPUT));
}

static void send_wheel(int delta) {
    INPUT in;
    memset(&in, 0, sizeof(in));
    in.type = INPUT_MOUSE;
    in.mi.dwFlags = MOUSEEVENTF_WHEEL;
    in.mi.mouseData = (DWORD)delta;
    SendInput(1, &in, sizeof(INPUT));
}

/* 平滑移动，用于拖拽；机器速度可能跟不上，所以插值分步走 */
static void glide(int x1, int y1, int x2, int y2, int ms) {
    if (ms <= 0) { SetCursorPos(x2, y2); return; }
    int steps = ms / 10;
    if (steps < 4) steps = 4;
    if (steps > 200) steps = 200;
    for (int i = 1; i <= steps; i++) {
        double t = (double)i / (double)steps;
        int x = (int)(x1 + (x2 - x1) * t);
        int y = (int)(y1 + (y2 - y1) * t);
        SetCursorPos(x, y);
        Sleep((DWORD)(ms / steps));
    }
    SetCursorPos(x2, y2);
}

static int need_int(const char *s, int *out) {
    if (!s) return 0;
    char *end = NULL;
    long v = strtol(s, &end, 10);
    if (end == s) return 0;
    *out = (int)v;
    return 1;
}

int main(int argc, char **argv) {
    make_dpi_aware();

    if (argc < 2) {
        printf("usage: orb-input <cursor|move|press|release|longpress|drag|scroll> ...\n");
        return 2;
    }

    const char *cmd = argv[1];
    int x = 0, y = 0, x2 = 0, y2 = 0, ms = 0, clicks = 1;

    if (_stricmp(cmd, "cursor") == 0) {
        POINT p;
        if (!GetCursorPos(&p)) { printf("ERROR: GetCursorPos failed\n"); return 1; }
        printf("cursor %ld %ld\n", (long)p.x, (long)p.y);
        return 0;
    }

    if (_stricmp(cmd, "move") == 0) {
        if (!need_int(argv[2], &x) || !need_int(argv[3], &y)) { printf("ERROR: need x y\n"); return 2; }
        SetCursorPos(x, y);
        printf("moved %d %d\n", x, y);
        return 0;
    }

    if (_stricmp(cmd, "press") == 0) {
        if (!need_int(argv[2], &x) || !need_int(argv[3], &y)) { printf("ERROR: need x y\n"); return 2; }
        const char *btn = argc > 4 ? argv[4] : "left";
        if (x >= 0 && y >= 0) {
            SetCursorPos(x, y);
            Sleep(20);
        }
        send_button(flag_down(btn), 0);
        printf("pressed %s at %d %d\n", btn, x, y);
        return 0;
    }

    if (_stricmp(cmd, "release") == 0) {
        const char *btn = argc > 2 ? argv[2] : "left";
        send_button(flag_up(btn), 0);
        printf("released %s\n", btn);
        return 0;
    }

    if (_stricmp(cmd, "longpress") == 0) {
        if (!need_int(argv[2], &x) || !need_int(argv[3], &y) || !need_int(argv[4], &ms)) {
            printf("ERROR: need x y ms\n");
            return 2;
        }
        const char *btn = argc > 5 ? argv[5] : "left";
        if (ms < 1) ms = 1;
        if (ms > 60000) ms = 60000;

        if (x >= 0 && y >= 0) {
            SetCursorPos(x, y);
            Sleep(30);                   /* 等鼠标真的落到位，否则按下位置会偏 */
        }
        send_button(flag_down(btn), 0);
        Sleep((DWORD)ms);                /* 保持按下 —— 这就是「长按」 */
        send_button(flag_up(btn), 0);
        printf("longpressed %s at %d %d for %d ms\n", btn, x, y, ms);
        return 0;
    }

    if (_stricmp(cmd, "drag") == 0) {
        if (!need_int(argv[2], &x) || !need_int(argv[3], &y) ||
            !need_int(argv[4], &x2) || !need_int(argv[5], &y2)) {
            printf("ERROR: need x1 y1 x2 y2\n");
            return 2;
        }
        ms = 400;
        if (argc > 6) { int t = 0; if (need_int(argv[6], &t)) ms = t; }
        const char *btn = argc > 7 ? argv[7] : "left";

        SetCursorPos(x, y);
        Sleep(30);
        send_button(flag_down(btn), 0);
        glide(x, y, x2, y2, ms);
        Sleep(30);
        send_button(flag_up(btn), 0);
        printf("dragged %s from %d %d to %d %d over %d ms\n", btn, x, y, x2, y2, ms);
        return 0;
    }

    if (_stricmp(cmd, "scroll") == 0) {
        if (!need_int(argv[2], &x) || !need_int(argv[3], &y)) { printf("ERROR: need x y\n"); return 2; }
        const char *dir = argc > 4 ? argv[4] : "down";
        if (argc > 5) { int c = 1; if (need_int(argv[5], &c)) clicks = c; }
        if (clicks < 1) clicks = 1;
        if (clicks > 100) clicks = 100;

        SetCursorPos(x, y);
        Sleep(20);
        for (int i = 0; i < clicks; i++) {
            if (_stricmp(dir, "up") == 0) send_wheel(WHEEL_DELTA);
            else send_wheel(-WHEEL_DELTA);
            Sleep(30);
        }
        printf("scrolled %s x%d at %d %d\n", dir, clicks, x, y);
        return 0;
    }

    printf("ERROR: unknown command '%s'\n", cmd);
    return 2;
}
