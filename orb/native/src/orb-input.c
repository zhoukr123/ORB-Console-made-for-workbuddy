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

/* ---------------- 键盘（key 子命令） ----------------
 * 键名 → 虚拟键码。只列实测用得上的那几十个。
 * SendInput 的 KEYBDINPUT 在 64 位下 dwFlags 之后还有 padding，
 * 直接 memset 清零再填字段，不要用初始化器（对齐会错）。 */
static WORD vk_of(const char *name) {
    if (!name || !*name) return 0;
    if (_stricmp(name, "esc") == 0 || _stricmp(name, "escape") == 0) return VK_ESCAPE;
    if (_stricmp(name, "enter") == 0 || _stricmp(name, "return") == 0) return VK_RETURN;
    if (_stricmp(name, "tab") == 0) return VK_TAB;
    if (_stricmp(name, "space") == 0) return VK_SPACE;
    if (_stricmp(name, "backspace") == 0) return VK_BACK;
    if (_stricmp(name, "left") == 0) return VK_LEFT;
    if (_stricmp(name, "right") == 0) return VK_RIGHT;
    if (_stricmp(name, "up") == 0) return VK_UP;
    if (_stricmp(name, "down") == 0) return VK_DOWN;
    if (_stricmp(name, "home") == 0) return VK_HOME;
    if (_stricmp(name, "end") == 0) return VK_END;
    if (_stricmp(name, "delete") == 0 || _stricmp(name, "del") == 0) return VK_DELETE;
    if (_stricmp(name, "f1") == 0) return VK_F1;
    if (_stricmp(name, "f2") == 0) return VK_F2;
    if (_stricmp(name, "f3") == 0) return VK_F3;
    if (_stricmp(name, "f4") == 0) return VK_F4;
    if ((name[0] == 'f' || name[0] == 'F') && name[1] >= '0' && name[1] <= '9') {
        int n = name[1] - '0';
        if (n >= 1 && n <= 9) return (WORD)(VK_F1 + n - 1);
    }
    /* 单字符 → 按键码（ASCII 一律映射到 VK 布局的等价虚拟键） */
    if (name[1] == '\0') {
        char c = name[0];
        if (c >= 'a' && c <= 'z') return (WORD)(c - 'a' + 'A');
        if (c >= 'A' && c <= 'Z') return (WORD)c;
        if (c >= '0' && c <= '9') return (WORD)c;
        if (c == '+') return VK_OEM_PLUS;
        if (c == '-') return VK_OEM_MINUS;
    }
    return 0;
}

/* 组合键：修饰键（Ctrl/Shift/Alt）要作为**独立按键**先按下，
   再按主键，最后依次抬起 —— 不能用 dwFlags 里的修饰位（那不是这么用的）。
   扩展键标志（方向键/Home/End 等）需要 KEYEVENTF_EXTENDEDKEY。 */
#define ORB_KEYEVENTF_EXTENDEDKEY 0x0001
#define ORB_KEYEVENTF_KEYUP        0x0002

static void key_event(WORD vk, BOOL up, BOOL extended) {
    INPUT in;
    memset(&in, 0, sizeof(in));
    in.type = INPUT_KEYBOARD;
    in.ki.wVk = vk;
    in.ki.dwFlags = up ? ORB_KEYEVENTF_KEYUP : 0;
    if (extended) in.ki.dwFlags |= ORB_KEYEVENTF_EXTENDEDKEY;
    SendInput(1, &in, sizeof(INPUT));
}

/* 这些键在扩展键盘布局里，必须带 EXTENDEDKEY 标志 */
static BOOL is_extended_key(WORD vk) {
    switch (vk) {
        case VK_LEFT: case VK_RIGHT: case VK_UP: case VK_DOWN:
        case VK_HOME: case VK_END: case VK_INSERT: case VK_DELETE:
        case VK_DIVIDE: case VK_NUMPAD0: case VK_NUMPAD1: case VK_NUMPAD2:
        case VK_NUMPAD3: case VK_NUMPAD4: case VK_NUMPAD5: case VK_NUMPAD6:
        case VK_NUMPAD7: case VK_NUMPAD8: case VK_NUMPAD9:
        case VK_DECIMAL: case VK_APPS: case VK_PRIOR: case VK_NEXT:
            return TRUE;
        default:
            return FALSE;
    }
}

static void send_key(WORD vk, BOOL ctrl, BOOL shift, BOOL alt) {
    BOOL ext = is_extended_key(vk);
    if (ctrl)  key_event(VK_CONTROL, FALSE, FALSE);
    if (shift) key_event(VK_SHIFT,   FALSE, FALSE);
    if (alt)   key_event(VK_MENU,    FALSE, FALSE);
    Sleep(20);
    key_event(vk, FALSE, ext);
    Sleep(30);
    key_event(vk, TRUE, ext);
    Sleep(20);
    if (alt)   key_event(VK_MENU,    TRUE, FALSE);
    if (shift) key_event(VK_SHIFT,   TRUE, FALSE);
    if (ctrl)  key_event(VK_CONTROL, TRUE, FALSE);
}

int main(int argc, char **argv) {
    make_dpi_aware();

    if (argc < 2) {
        printf("usage: orb-input <cursor|move|press|release|longpress|drag|scroll|key> ...\n");
        return 2;
    }

    const char *cmd = argv[1];
    int x = 0, y = 0, x2 = 0, y2 = 0, ms = 0, clicks = 1;

    /* key <键名> [ctrl] [shift] [alt] —— 发一次按键（按下+抬起）。 */
    if (_stricmp(cmd, "key") == 0) {
        if (argc < 3) { printf("ERROR: need key name\n"); return 2; }
        WORD vk = vk_of(argv[2]);
        if (!vk) { printf("ERROR: unknown key %s\n", argv[2]); return 2; }
        BOOL ctrl = (argc > 3 && _stricmp(argv[3], "ctrl") == 0);
        BOOL shift = (argc > 4 && _stricmp(argv[4], "shift") == 0);
        BOOL alt = (argc > 5 && _stricmp(argv[5], "alt") == 0);
        send_key(vk, ctrl, shift, alt);
        printf("keyed %s\n", argv[2]);
        return 0;
    }

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
