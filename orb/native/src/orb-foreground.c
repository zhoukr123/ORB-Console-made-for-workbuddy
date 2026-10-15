/*
 * orb-foreground.exe —— Orb 的前台窗口探针（常驻进程 + 行协议）
 *
 * 为什么要有它：
 *   「观察边框」需要知道用户此刻真正在用哪个窗口。原来的做法是
 *   `pollForeground()` 每 500ms spawn 一次 powershell.exe，脚本里还要
 *   Add-Type 现场编译一段 user32 的 P/Invoke —— 单次 1~3 秒、峰值吃满一个核，
 *   面板开着就一直烧。这是 ORB 空闲态 CPU 占用的头号来源。
 *
 *   换成本进程后：常驻一个 ~50KB 的原生进程，每次查询只是
 *   「写一行 stdin / 读一行 stdout」，实测单次 < 2ms（见 PERF 报告），
 *   并且**完全不再创建进程**。
 *
 * ★★ 关键：本进程**故意不做** DPI aware 声明 ★★
 *   注意这和 orb-input.c 正好相反 —— 那边明确调用了
 *   SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)。
 *
 *   原因：PowerShell 回退路径里的 powershell.exe 是 DPI-unaware 的，
 *   Windows 会替 unaware 进程把 GetWindowRect 的返回值虚拟化成**逻辑坐标**，
 *   而 updateBorder() 拿到这个矩形后直接喂给 BrowserWindow.setBounds()，
 *   Electron 用的也是 DIP —— 两边同一个坐标系，所以原来是对的。
 *
 *   如果这里声明了 DPI aware，GetWindowRect 就会返回**物理像素**，
 *   在 125% / 150% 缩放的机器上，观察边框会整体画错位置和尺寸。
 *   这种「只在缩放屏上才错、开发机 100% 缩放永远试不出来」的偏差极难排查。
 *   所以：**要换坐标系就必须同时改 PowerShell 与原生两条路径，绝不能只改一条。**
 *
 * 用法：
 *   orb-foreground              # 一次性：查一次前台窗口，打一行 JSON 后退出
 *   orb-foreground --serve      # 常驻：从 stdin 逐行读命令
 *
 * 常驻模式协议（每行一个 JSON，UTF-8，\n 结尾）：
 *   启动即输出：  {"ok":true,"ready":true}
 *   输入 {"cmd":"fg"}    → {"ok":true,"hwnd":..,"pid":..,"title":"..","exe":"..",
 *                            "rect":[l,t,r,b],"dwm":[l,t,r,b]|null}
 *   输入 {"cmd":"ping"}  → {"ok":true,"pong":true}
 *   输入 {"cmd":"quit"}  → {"ok":true,"bye":true} 然后退出
 *
 * 字段说明：
 *   rect —— GetWindowRect 的结果，**逻辑坐标**，与 PowerShell 路径逐字节等价
 *   dwm  —— DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS) 的结果；
 *           取不到时为 null。Win10+ 上 rect 会含一圈看不见的缩放边框，
 *           将来若要把边框贴得更准就用这个字段。本次改造**不使用**它，
 *           以保证与现有行为完全一致。
 *
 * 编码约定：输出里所有非 ASCII 字符一律 \uXXXX 转义，因此 stdout 是纯 ASCII，
 *   彻底绕开控制台代码页（936 / 65001）的坑 —— 窗口标题里带中文也不会乱码。
 *
 * 退出码：0 正常；2 用法错误。
 */

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <io.h>
#include <fcntl.h>

#ifndef PROCESS_QUERY_LIMITED_INFORMATION
#define PROCESS_QUERY_LIMITED_INFORMATION (0x1000)
#endif

#define FG_LINE_MAX 8192
#define FG_TITLE_MAX 512

static void out_line(const char *s) {
    fwrite(s, 1, strlen(s), stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

/*
 * 宽字符串 → JSON 转义的 ASCII。
 * 每个 UTF-16 码元单独转义：ASCII 可见字符原样输出，其余（含代理对）
 * 一律 \uXXXX —— JSON.parse 会把代理对重新拼回正确的字符。
 */
static void json_escape_w(const WCHAR *s, char *out, size_t cap) {
    size_t o = 0;
    for (const WCHAR *p = s; *p; ++p) {
        WCHAR c = *p;
        char esc[8];
        size_t n = 0;

        if (c == L'"')       { memcpy(esc, "\\\"", 2); n = 2; }
        else if (c == L'\\') { memcpy(esc, "\\\\", 2); n = 2; }
        else if (c == L'\n') { memcpy(esc, "\\n", 2);  n = 2; }
        else if (c == L'\r') { memcpy(esc, "\\r", 2);  n = 2; }
        else if (c == L'\t') { memcpy(esc, "\\t", 2);  n = 2; }
        else if (c == L'\b') { memcpy(esc, "\\b", 2);  n = 2; }
        else if (c == L'\f') { memcpy(esc, "\\f", 2);  n = 2; }
        else if (c < 0x20 || c > 0x7E) {
            n = (size_t)snprintf(esc, sizeof(esc), "\\u%04x", (unsigned int)c);
        } else {
            esc[0] = (char)c;
            n = 1;
        }

        if (o + n + 1 >= cap) break;
        memcpy(out + o, esc, n);
        o += n;
    }
    out[o] = '\0';
}

/** 取进程的可执行文件名（不含路径）。拿不到就留空，不算错误。 */
static void process_name(DWORD pid, WCHAR *out, size_t cap) {
    out[0] = L'\0';
    if (!pid) return;

    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!h) return;

    WCHAR full[MAX_PATH];
    DWORD sz = (DWORD)MAX_PATH;
    if (QueryFullProcessImageNameW(h, 0, full, &sz)) {
        const WCHAR *base = wcsrchr(full, L'\\');
        base = base ? base + 1 : full;
        wcsncpy_s(out, cap, base, _TRUNCATE);
    }
    CloseHandle(h);
}

/* DWM 真实边框：动态加载，避免引入 dwmapi.lib 的链接依赖
   （构建脚本照 build.ps1 的先例只链 user32.lib）。 */
typedef HRESULT (WINAPI *DwmGetAttrFn)(HWND, DWORD, PVOID, DWORD);

static int dwm_bounds(HWND hwnd, RECT *out) {
    const DWORD DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    HMODULE m = GetModuleHandleW(L"dwmapi.dll");
    if (!m) m = LoadLibraryW(L"dwmapi.dll");
    if (!m) return 0;
    DwmGetAttrFn fn = (DwmGetAttrFn)GetProcAddress(m, "DwmGetWindowAttribute");
    if (!fn) return 0;
    return SUCCEEDED(fn(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out, (DWORD)sizeof(RECT))) ? 1 : 0;
}

static void emit_fg(void) {
    HWND hwnd = GetForegroundWindow();
    if (!hwnd) {
        out_line("{\"ok\":false,\"error\":\"no foreground window\"}");
        return;
    }

    RECT r;
    if (!GetWindowRect(hwnd, &r)) {
        out_line("{\"ok\":false,\"error\":\"GetWindowRect failed\"}");
        return;
    }

    RECT dr;
    int has_dwm = dwm_bounds(hwnd, &dr);

    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);

    WCHAR title[FG_TITLE_MAX];
    title[0] = L'\0';
    GetWindowTextW(hwnd, title, FG_TITLE_MAX);

    WCHAR exe[MAX_PATH];
    process_name(pid, exe, MAX_PATH);

    char esc_title[FG_LINE_MAX];
    char esc_exe[FG_LINE_MAX];
    json_escape_w(title, esc_title, sizeof(esc_title));
    json_escape_w(exe, esc_exe, sizeof(esc_exe));

    char dwm_json[128];
    if (has_dwm) {
        snprintf(dwm_json, sizeof(dwm_json),
                 "[%ld,%ld,%ld,%ld]",
                 (long)dr.left, (long)dr.top, (long)dr.right, (long)dr.bottom);
    } else {
        snprintf(dwm_json, sizeof(dwm_json), "null");
    }

    char line[FG_LINE_MAX * 2 + 256];
    snprintf(line, sizeof(line),
             "{\"ok\":true,\"hwnd\":%llu,\"pid\":%lu,\"title\":\"%s\",\"exe\":\"%s\","
             "\"rect\":[%ld,%ld,%ld,%ld],\"dwm\":%s}",
             (unsigned long long)(UINT_PTR)hwnd,
             (unsigned long)pid,
             esc_title, esc_exe,
             (long)r.left, (long)r.top, (long)r.right, (long)r.bottom,
             dwm_json);
    out_line(line);
}

/** 常驻模式：逐行读 stdin，逐行答 stdout。stdin 关闭（父进程没了）就正常退出。 */
static int serve(void) {
    char in[512];
    out_line("{\"ok\":true,\"ready\":true}");

    while (fgets(in, (int)sizeof(in), stdin)) {
        /* 只认 cmd 字段，不引入 JSON 解析器 —— 命令就三种，没必要。 */
        const char *cmd = strstr(in, "\"cmd\"");
        if (!cmd) { out_line("{\"ok\":false,\"error\":\"missing cmd\"}"); continue; }
        cmd = strchr(cmd, ':');
        if (!cmd) { out_line("{\"ok\":false,\"error\":\"malformed cmd\"}"); continue; }
        cmd++;
        while (*cmd == ' ' || *cmd == '"') cmd++;

        if (strncmp(cmd, "fg", 2) == 0)        emit_fg();
        else if (strncmp(cmd, "ping", 4) == 0) out_line("{\"ok\":true,\"pong\":true}");
        else if (strncmp(cmd, "quit", 4) == 0) { out_line("{\"ok\":true,\"bye\":true}"); return 0; }
        else out_line("{\"ok\":false,\"error\":\"unknown cmd\"}");
    }
    return 0;
}

int main(int argc, char **argv) {
    /* 二进制模式：避免 \n 被翻译成 \r\n，让对端按 \n 切行时留下尾巴。 */
    _setmode(_fileno(stdout), _O_BINARY);
    _setmode(_fileno(stdin), _O_BINARY);

    if (argc >= 2 && _stricmp(argv[1], "--serve") == 0) return serve();
    if (argc >= 2 && _stricmp(argv[1], "--help") == 0) {
        printf("usage: orb-foreground [--serve] [--help]\n");
        return 2;
    }

    /* 一次性模式：给构建脚本自检用 */
    emit_fg();
    return 0;
}
