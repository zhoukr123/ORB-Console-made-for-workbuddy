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
 *   输入 {"cmd":"snap"}  → {"ok":true,"snipping":bool,"ready":bool,"seq":<剪贴板序列号>}
 *   输入 {"cmd":"snip"}  → {"ok":true,"snipping":bool,"ready":bool}
 *   输入 {"cmd":"ping"}  → {"ok":true,"pong":true}
 *   输入 {"cmd":"quit"}  → {"ok":true,"bye":true} 然后退出
 *
 * ⚠️ snap 与 snip 的区别：snap 额外带上剪贴板序列号（GetClipboardSequenceNumber），
 *    且**一次往返同时给出**截屏态 —— 本进程是单通道管道，查询种类越多，
 *    与观察边框的前台查询争用越频繁（后到的会把先到的 settle(null) 打断）。
 *    截屏流程要的正是这两样，合成一条最省。
 *    序列号只在**内容被改写**时 +1，与内容无关 —— 用来判断"剪贴板被写过"
 *    比比较图片字节可靠（旧图新图字节相同、或基线读取失败时，指纹法都会误判）。
 *
 * ⚠️ snipping 的含义：**Snipaste 当前是否处在截屏会话（框选 / 标注栏）中**。
 *    ready 的含义：**Snipaste 的框选浮层窗口是否存在**（不论可见与否）。
 *    两个标志语义不同，JS 侧要用对 —— 见下方 enum_snip 的注释。
 *    判据返工过四次，绝对判据（有可见窗口 / hwnd 集合变化 / 黑名单排除）
 *    在实测中都会失效，详见 enum_snip 上方的说明。
 *    调用方靠 **true → false 的跳变** 判断"用户取消了"，不是靠绝对值。
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
#include <psapi.h>      /* EnumProcesses / QueryFullProcessImageNameW（snip 命令用） */

#ifndef PROCESS_QUERY_LIMITED_INFORMATION
#define PROCESS_QUERY_LIMITED_INFORMATION (0x1000)
#endif

#define FG_LINE_MAX 8192
#define FG_TITLE_MAX 512

/*
 * 请求 id：由 **JS 侧**生成、原样带回（native 不自己分配）。
 *
 * 为什么必须有（2026-10-24 实测出来的坑）：
 *   JS 侧是**单通道**管道 —— 同时只能有一个在途查询（fgPending）。
 *   新查询会抢占旧查询（把旧的 settle(null) 掉），但**被抢占那条请求的
 *   响应行照样会从 stdout 回来**。管道是严格 FIFO，于是这条"孤儿响应"
 *   会被投递给下一个占槽者 —— 响应错配。
 *   实测错配率 4.7%，最坏连续 2 轮。而"连续 2 轮 snipping=false"正好是
 *   "判用户取消"的阈值 → 一次错配就可能把正常截图判成取消、丢掉用户的图。
 *   带上 id 之后，JS 只接受 id 对得上的回包，孤儿响应直接丢弃。
 *
 * 协议：请求 {"cmd":"snap","id":42} → 回包 {"ok":true,"id":42,...}
 *   id 可选（不传就是 0），保持对旧调用的兼容。
 */

/** 从请求行里取出 "id" 字段（没有就给 0）。 */
static long parse_req_id(const char *line) {
    const char *p = strstr(line, "\"id\"");
    if (!p) return 0;
    p = strchr(p, ':');
    if (!p) return 0;
    p++;
    while (*p == ' ' || *p == '\t') p++;
    return strtol(p, NULL, 10);
}

/** 命令名精确匹配：名字后面必须是结束引号 / 空白 / 行尾。
 *  原来的 strncmp(cmd,"snap",4) 是**前缀匹配** —— 将来加一条
 *  "snipaste" 或 "snapshot" 之类的命令会被静默走错分支，且不报错。 */
static int cmd_is(const char *cmd, const char *name) {
    size_t n = strlen(name);
    if (strncmp(cmd, name, n) != 0) return 0;
    char c = cmd[n];
    return c == '\0' || c == '"' || c == ' ' || c == '\t' || c == '\r' || c == '\n';
}

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

static void emit_fg(long req_id) {
    HWND hwnd = GetForegroundWindow();
    if (!hwnd) {
        char buf[96];
        snprintf(buf, sizeof(buf), "{\"ok\":false,\"id\":%ld,\"error\":\"no foreground window\"}", req_id);
        out_line(buf);
        return;
    }

    RECT r;
    if (!GetWindowRect(hwnd, &r)) {
        char buf[96];
        snprintf(buf, sizeof(buf), "{\"ok\":false,\"id\":%ld,\"error\":\"GetWindowRect failed\"}", req_id);
        out_line(buf);
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
             "{\"ok\":true,\"id\":%ld,\"hwnd\":%llu,\"pid\":%lu,\"title\":\"%s\",\"exe\":\"%s\","
             "\"rect\":[%ld,%ld,%ld,%ld],\"dwm\":%s}",
             req_id,
             (unsigned long long)(UINT_PTR)hwnd,
             (unsigned long)pid,
             esc_title, esc_exe,
             (long)r.left, (long)r.top, (long)r.right, (long)r.bottom,
             dwm_json);
    out_line(line);
}

/* ------------------------------------------------------------------ *
 * snip —— Snipaste 的截屏会话状态
 *
 * ★★ 这条判据被返工过四次，每次都是因为判据不精确 ★★
 *
 * 第一版：「Snipaste 有没有可见顶层窗口」。错 —— 干净启动时确实 0 个可见
 *   窗口，但用户点开托盘面板、或上次框选没结束时就有 → 恒 true。
 * 第二版：「可见窗口的 hwnd 集合有没有变化」。也错 —— 框选浮层在**冷启动时
 *   hwnd 就已经存在**（class Qt624QWindowToolSaveBits, title `Snipper -
 *   Snipaste`），空闲时 1×1 不可见，框选时同一个 hwnd 变成全屏可见。
 * 第三版：「排除主面板，看还有没有别的可见窗口」。还是错 —— **黑名单漏网**：
 *   实测以下窗口全被判成"正在截屏"：
 *     `Paster - Snipaste`（贴图窗）、`Snipaste Preferences`（偏好设置）、
 *     `Snipaste 2 PRO`（PRO 设置）、`ShareUiHelper - Snipaste`（分享窗）、
 *     `QTrayIconMessageWindow`（托盘气泡）。
 *   连带后果：用户开着贴图窗时 ORB 的截屏按钮**完全点不动**
 *   （守卫判 busy → 不发 snip 命令 → 截屏功能整个不可用）。
 *   教训：**黑名单永远漏**。Snipaste 有多少种窗口我们并不知道。
 *
 * 第四版（现在的）：**白名单精确识别**，只认两种窗口：
 *   ① 框选浮层 —— 面积 ≥ 所在显示器面积的 60%。
 *      · 判几何不判标题字符串，Snipaste 改标题也不会失效；
 *      · 实测浮层 1707×1067 全屏（比≈1.0），主面板 169×221（比≈0.02）；
 *      · 同时要求类名含 ToolSaveBits（Qt 的工具窗口基类）。
 *   ② 标注工具栏 —— 类名含 "QWindowIcon"（Qt 普通窗口基类，与浮层的
 *      ToolSaveBits 不同）且标题不含 "ShareUiHelper"（分享窗也用这个类）。
 *      · 实测标注工具栏 427×33。
 *
 * ★ 输出**两个**标志，语义不同，JS 侧要用对：
 *   snipping = 处在截屏会话中（上面两种窗口之一**可见**）
 *   ready    = Snipaste 的框选浮层窗口**存在**（不论可见与否）
 *   为什么要 ready：JS 侧要区分两种"没有截屏态"——
 *     · ready=false → Snipaste 压根没有浮层窗口（版本不同 / 被禁用了）
 *       → 这次 snip 命令多半没生效，可以早点放弃；
 *     · ready=true 但 snipping=false → 浮层窗口在但不可见
 *       → 可能是用户开着贴图窗、或浮层还没建出来 → **不能**用
 *         "没进过截屏态"去否定用户，只能等剪贴板序列号变化或总超时。
 *   ⚠️ 早期版本这里用的是「Snipaste 有任何可见窗口」（alive），实测**太宽**：
 *     Snipaste 空闲时主面板 169×221 就是常可见的 → alive 恒为 true
 *     → "压根没弹框选"的兜底永远不触发 → 面板被锁 180 秒。
 *
 * ★ 调用方靠 **true → false 的跳变** 判断"用户取消了"，不是靠绝对值。
 * ------------------------------------------------------------------ */
typedef struct {
    DWORD pid;
    int   snipping;   /* 见到可见的截屏会话窗口 */
    int   ready;      /* 见到框选浮层窗口（不论可见） */
} snip_ctx;



/** 面积比 ≥ 阈值 → 认为是大尺寸（浮层级）窗口 */
static int is_big_window(HWND hwnd) {
    RECT r;
    if (!GetWindowRect(hwnd, &r)) return 0;
    long w = (long)(r.right - r.left);
    long h = (long)(r.bottom - r.top);
    if (w <= 0 || h <= 0) return 0;

    /* 面积比：相对**它自己所在的显示器**，而不是虚拟桌面总面积。 */
    HMONITOR mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
    MONITORINFO mi;
    mi.cbSize = sizeof(mi);
    if (!GetMonitorInfoW(mon, &mi)) return 0;
    long mw = (long)(mi.rcMonitor.right - mi.rcMonitor.left);
    long mh = (long)(mi.rcMonitor.bottom - mi.rcMonitor.top);
    if (mw <= 0 || mh <= 0) return 0;

    return ((double)w * (double)h >= 0.6 * (double)mw * (double)mh);
}



/** 收集名为 process 的所有进程 PID（可能有多实例）。返回个数。 */
static int find_pids(const WCHAR *process, DWORD *out, int max) {
    /* ⚠️ 缓冲区必须够大：EnumProcesses 返回的是**全部**进程 PID，
       顺序与 PID 大小无关，实测 Snipaste 的 PID 会落在前 64 个之外 ——
       早期版本数组只有 64 个，直接把它截没了，于是"框选中"永远查不出来。 */
    DWORD pids[1024];
    DWORD need = 0;
    if (!EnumProcesses(pids, sizeof(pids), &need)) return 0;
    DWORD n = need / sizeof(DWORD);
    if (n > 1024) n = 1024;

    int cnt = 0;
    for (DWORD i = 0; i < n; i++) {
        if (!pids[i]) continue;
        HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pids[i]);
        if (!h) continue;
        WCHAR name[MAX_PATH];
        DWORD len = MAX_PATH;
        int ok = QueryFullProcessImageNameW(h, 0, name, &len);
        CloseHandle(h);
        if (!ok) continue;
        /* 只比文件名尾部，避免路径前缀差异 */
        const WCHAR *base = wcsrchr(name, L'\\');
        base = base ? base + 1 : name;
        if (_wcsicmp(base, process) != 0) continue;
        if (cnt < max) out[cnt++] = pids[i];
    }
    return cnt;
}


/**
 * 框选浮层窗口是否存在（不论可见与否）。
 *
 * 依据：浮层窗口在 Snipaste **冷启动时 hwnd 就已经存在**（1×1、不可见），
 * 框选时同一个 hwnd 变成全屏可见。所以"窗口存在"能可靠回答
 * "这个 Snipaste 到底有没有框选能力"，而"窗口可见且够大"回答
 * "现在是不是正在框选"。两个问题必须分开问。
 *
 * ⚠️ 类名带版本号（Qt624 / Qt625 …），不能按类名硬找 ——
 *   所以这里枚举**所有**顶层窗口（含不可见），按标题里的 "Snipper" 认。
 */
static BOOL CALLBACK enum_overlay_exists(HWND hwnd, LPARAM lp) {
    DWORD want = (DWORD)lp;
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid != want) return TRUE;

    WCHAR cls[128];
    cls[0] = L'\0';
    GetClassNameW(hwnd, cls, 128);
    if (wcsstr(cls, L"ToolSaveBits") == NULL) return TRUE;

    WCHAR title[256];
    title[0] = L'\0';
    GetWindowTextW(hwnd, title, 256);
    if (wcsstr(title, L"Snipper") != NULL) return FALSE;   /* 找到了 */
    return TRUE;
}

static int snip_overlay_exists(void) {
    DWORD pids[16];
    int n = find_pids(L"Snipaste.exe", pids, 16);
    for (int i = 0; i < n; i++) {
        if (!EnumWindows(enum_overlay_exists, (LPARAM)pids[i])) return 1;
    }
    return 0;
}
static BOOL CALLBACK enum_snip(HWND hwnd, LPARAM lp) {
    snip_ctx *c = (snip_ctx *)lp;
    if (!IsWindowVisible(hwnd)) return TRUE;          /* 不可见：跳过 */
    if (IsIconic(hwnd)) return TRUE;                  /* 最小化：不算 */

    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid != c->pid) return TRUE;

    RECT r;
    if (!GetWindowRect(hwnd, &r)) return TRUE;
    if ((r.right - r.left) <= 0 || (r.bottom - r.top) <= 0) return TRUE;

    c->ready = 0;       /* ready 由 snip_overlay_exists 单独判定 */

    WCHAR cls[128];
    cls[0] = L'\0';
    GetClassNameW(hwnd, cls, 128);
    WCHAR title[256];
    title[0] = L'\0';
    GetWindowTextW(hwnd, title, 256);

    /* ① 框选浮层：ToolSaveBits 类 + 大尺寸（比标题字符串可靠）
     *    ⚠️ 但纯靠尺寸有极端情况漏判：设置窗口若开到全屏尺寸也会命中。
     *    所以再加一道标题确认 —— 实测浮层的标题恒为 "Snipper - Snipaste"
     *    （"Snipper" 是 Snipaste 对框选浮层的固定叫法），而设置窗口是
     *    "Snipaste Preferences"、贴图窗是 "Paster - Snipaste"。
     *    两者同时满足才算浮层 —— 误判概率压到极低。 */
    if (wcsstr(cls, L"ToolSaveBits") != NULL &&
        wcsstr(title, L"Snipper") != NULL &&
        is_big_window(hwnd)) {
        c->snipping = 1;
        return FALSE;      /* 找到了，提前收工 */
    }
    /* ② 标注工具栏：QWindowIcon 类 + 标题含 "Toolbar"
     *    ⚠️ 为什么不按类名一刀切：实测存在 class 同样是 QWindowIcon、
     *      标题分别是 "Snipaste"（441×357 的功能面板）和
     *      "ShareUiHelper - Snipaste"（分享窗）的可见窗口 ——
     *      它们都与截屏无关，一刀切会把它们当成标注工具栏。
     *    实测真正的标注工具栏标题是 "Snipaste Toolbar"（427×33），
     *    所以按标题里的 "Toolbar" 认，比按类名精确。
     *    （标题含 Toolbar 的排除项：ShareUiHelper 不含 → 自动排除。） */
    if (wcsstr(cls, L"QWindowIcon") != NULL &&
        wcsstr(title, L"Toolbar") != NULL) {
        c->snipping = 1;
        return FALSE;
    }
    return TRUE;
}
/** 扫描 Snipaste 的窗口。返回 snipping / ready 两个标志。 */
static void snip_scan(int *snipping, int *ready) {
    DWORD pids[16];
    int n = find_pids(L"Snipaste.exe", pids, 16);
    *snipping = 0;
    for (int i = 0; i < n; i++) {
        snip_ctx c;
        c.pid = pids[i];
        c.snipping = 0;
        c.ready = 0;
        EnumWindows(enum_snip, (LPARAM)&c);
        if (c.snipping) *snipping = 1;
        if (*snipping) break;
    }
    /* ready 独立于 snipping：浮层窗口存在 ≠ 现在可见 */
    *ready = snip_overlay_exists();
}

/* snip 命令：只查截屏态，不带 seq。
   ⚠️ 与 snap 的区别不是"少一个字段"而是**用途不同**：
 *   snap  → 截屏流程轮询用（要 snipping + ready + seq 一次拿全）
 *   snip  → 「已在框选中就别重复发 snip」的守卫用（只要 snipping）
 *   守卫不需要 seq，所以不查 —— 单通道管道少一次往返就少一次争用。 */
static void emit_snip(long req_id) {
    int on = 0, ready = 0;
    snip_scan(&on, &ready);
    char line[224];
    snprintf(line, sizeof(line),
             "{\"ok\":true,\"id\":%ld,\"snipping\":%s,\"ready\":%s}",
             req_id, on ? "true" : "false", ready ? "true" : "false");
    out_line(line);
}

/* ------------------------------------------------------------------ *
 * snap —— 截屏态 + 剪贴板序列号，**一次查询拿两样**
 *
 * 为什么合并成一条命令：本进程是**单通道**管道，观察边框每 500ms 查一次
 * 前台、截屏轮询再查一次，两者共用一个 fgPending —— 后到的会把先到的
 * settle(null) 打断。查询种类越多，争用越频繁。所以把截屏流程真正需要的
 * 两项（Snipaste 是否在框选 + 剪贴板序列号）合成**一次往返**。
 *
 * 序列号（GetClipboardSequenceNumber）：每次剪贴板内容被改写就 +1，
 * **与内容无关**。用它判断"剪贴板有没有被写过"比比较图片字节可靠得多 ——
 *   · 新旧图字节完全相同（比如用户截了和之前一样的区域）→ 指纹法失效，
 *     序列号照样变；
 *   · 基线读取失败 → 指纹法会把旧图当成本次截图落盘，
 *     序列号法因为基线是整数、读取不会失败，天然没这个问题。
 *
 * ⚠️ 这里**不碰剪贴板内容**（不 OpenClipboard）：OpenClipboard 失败时
 *   别的进程写不进来，在 Snipaste 正在写图的那一刻去抢锁会打断它。
 *   只读序列号，不开剪贴板。
 * ------------------------------------------------------------------ */
static void emit_snap(long req_id) {
    int on = 0, ready = 0;
    snip_scan(&on, &ready);
    DWORD seq = GetClipboardSequenceNumber();
    char line[256];
    snprintf(line, sizeof(line),
             "{\"ok\":true,\"id\":%ld,\"snipping\":%s,\"ready\":%s,\"seq\":%lu}",
             req_id, on ? "true" : "false", ready ? "true" : "false",
             (unsigned long)seq);
    out_line(line);
}

/** 常驻模式：逐行读 stdin，逐行答 stdout。stdin 关闭（父进程没了）就正常退出。 */
static int serve(void) {
    char in[4096];
    out_line("{\"ok\":true,\"ready\":true}");

    while (fgets(in, (int)sizeof(in), stdin)) {
        /* 只认 cmd 字段，不引入 JSON 解析器 —— 命令就几种，没必要。
           ⚠️ 找的是**这一行里**的 "cmd" key；值里若含 "cmd" 字面量会取错，
           所以先找 "\"cmd\"" 再从它后面找冒号（冒号必须紧跟其后，
           不能是值里的冒号）。 */
        const char *cmd = strstr(in, "\"cmd\"");
        if (!cmd) { out_line("{\"ok\":false,\"error\":\"missing cmd\"}"); continue; }
        cmd = strchr(cmd, ':');
        if (!cmd) { out_line("{\"ok\":false,\"error\":\"malformed cmd\"}"); continue; }
        cmd++;
        /* 跳到引号：跳过空白（含 \r\n）与起始引号 */
        while (*cmd == ' ' || *cmd == '\t' || *cmd == '\r' || *cmd == '\n' || *cmd == '"') cmd++;

        /* 请求 id：回包原样带回，JS 侧据此识别"孤儿响应"（见 g_req_id 上方注释）。 */
        long req_id = parse_req_id(in);

        if (cmd_is(cmd, "fg"))        emit_fg(req_id);
        else if (cmd_is(cmd, "snap")) emit_snap(req_id);
        else if (cmd_is(cmd, "snip")) emit_snip(req_id);
        else if (cmd_is(cmd, "ping")) {
            char line[96];
            snprintf(line, sizeof(line), "{\"ok\":true,\"id\":%ld,\"pong\":true}", req_id);
            out_line(line);
        }
        else if (cmd_is(cmd, "quit")) {
            char line[96];
            snprintf(line, sizeof(line), "{\"ok\":true,\"id\":%ld,\"bye\":true}", req_id);
            out_line(line);
            return 0;
        }
        else {
            char line[128];
            snprintf(line, sizeof(line), "{\"ok\":false,\"id\":%ld,\"error\":\"unknown cmd\"}", req_id);
            out_line(line);
        }
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
    emit_fg(0);
    return 0;
}
