/*
 * orb-selection.exe —— Orb 的划词监听器（常驻进程 + 行协议）
 *
 * 为什么要有它：
 *   这件事原来由 selection-watch.ps1 干 —— 一个常驻 powershell.exe，
 *   每 60ms 轮询一次鼠标左右键 + 光标位置，命中拖拽后走 .NET 的
 *   UI Automation 读选区。代价：
 *     · 常驻一个 powershell.exe（连带 .NET 运行时），几十 MB 内存常驻不放
 *     · 60ms 轮询间隔，快速拖拽有概率整个错过（按下与抬起落在同一个间隔里）
 *     · 每次命中还要走一遍 PowerShell -> .NET -> COM 互操作，慢且抖
 *     · 启动时要 Add-Type 现场编译 P/Invoke，头 1~2 秒不可用
 *
 *   换成本进程后：常驻一个 ~100KB 的原生进程，16ms 轮询，UIA 直读。
 *
 * ★★ 关键一：为什么必须注册 UIA 事件订阅 ★★
 *   Chromium / Edge 只在「有 UIA 客户端在听」时才开启自己的无障碍树，
 *   否则读不到网页里的选中文字。这正是 PowerShell 版
 *   AddAutomationFocusChangedEventHandler 那一行的作用。
 *   本文件用 IUIAutomation::AddFocusChangedEventHandler 做同一件事，
 *   处理器本体什么都不做 —— 我们只关心「有客户端在听」这个事实。
 *
 * ★★ 关键二：DPI unaware ★★
 *   与 orb-foreground.c 一致：不声明 DPI aware。
 *   事件里虽然带 x/y，但主进程 main.js 的 handleWatchEvent 明确忽略它们、
 *   改用 Electron 自己的光标位置（注释就在那段代码上面），所以坐标系
 *   怎么都不影响行为。保持 unaware 只是为了让两条路径行为完全对齐，
 *   不引入新变量。
 *
 * 用法：
 *   orb-selection --serve      # 常驻：stdin 行协议 + 划词事件推送
 *   orb-selection --sel        # 一次性：读一次当前选区，打印后退出（自检）
 *   orb-selection --help
 *
 * 常驻协议（每行一个 JSON，UTF-8，\n 结尾）：
 *   启动即输出：  {"ok":true,"ready":true}
 *   输入 {"cmd":"ping"}  → {"ok":true,"pong":true}
 *   输入 {"cmd":"sel"}   → {"ok":true,"text":"..."} 或 {"ok":true,"text":null}
 *   输入 {"cmd":"quit"}  → {"ok":true,"bye":true} 然后退出
 *
 * 事件推送（无命令时也会往外打）。格式与 selection-watch.ps1 逐字节一致，
 *   主进程 handleWatchEvent 直接复用，一行都不用改：
 *   {"type":"select","x":..,"y":..,"cls":"..","text":"..."|null}
 *
 * 编码约定同 orb-foreground.c：输出里所有非 ASCII 字符一律 \uXXXX 转义，
 *   因此 stdout 是纯 ASCII，彻底绕开控制台代码页（936 / 65001）的坑。
 *
 * 退出码：0 正常；1 初始化失败；2 用法错误。
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <io.h>
#include <fcntl.h>

#include <objbase.h>
#include <uiautomation.h>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")
#pragma comment(lib, "uuid.lib")
#pragma comment(lib, "uiautomationcore.lib")
#pragma comment(lib, "user32.lib")

#define SEL_LINE_MAX   8192
#define SEL_DRAG_PX    8        /* 拖动位移阈值，与 PowerShell 版一致 */
#define SEL_SETTLE_MS  180      /* 抬起后等选区在目标应用里落定 */
#define SEL_POLL_MS    16       /* 轮询间隔；PowerShell 版是 60ms */
#define SEL_DEDUPE_MS  4000     /* 同一段文字 4 秒内不重复弹 */

static CRITICAL_SECTION g_out_lock;
static IUIAutomation   *g_uia = NULL;        /* 主线程(MTA)上的 UIA 实例 */
static volatile LONG    g_quit = 0;
static volatile LONG    g_sel_request = 0;
static DWORD            g_listener_tid = 0;

/* ---------------- 输出 ---------------- */

static void out_line(const char *s) {
    EnterCriticalSection(&g_out_lock);
    fwrite(s, 1, strlen(s), stdout);
    fputc('\n', stdout);
    fflush(stdout);
    LeaveCriticalSection(&g_out_lock);
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

/* ---------------- UIA 取词 ---------------- */

/* 可增长的宽字符缓冲 */
typedef struct { WCHAR *p; size_t len; size_t cap; } WBUF;

static int wbuf_push(WBUF *b, const WCHAR *s, size_t n) {
    if (b->len + n + 1 > b->cap) {
        size_t nc = b->cap ? b->cap * 2 : 512;
        while (nc < b->len + n + 1) nc *= 2;
        WCHAR *np = (WCHAR *)realloc(b->p, nc * sizeof(WCHAR));
        if (!np) return 0;
        b->p = np;
        b->cap = nc;
    }
    memcpy(b->p + b->len, s, n * sizeof(WCHAR));
    b->len += n;
    b->p[b->len] = L'\0';
    return 1;
}

/**
 * 读焦点元素的 TextPattern 选区。
 *
 * 焦点元素优先 —— 这正是 PowerShell 版注释里踩过的坑：用
 * FindFirst(Descendants) 会命中页面里第一个带 TextPattern 的元素，
 * 而不是真正持有选区的那个。
 *
 * 返回 malloc 出来的宽字符串（调用方 free），读不到或为空返回 NULL。
 */
static WCHAR *read_uia_selection(IUIAutomation *uia) {
    if (!uia) return NULL;

    IUIAutomationElement *el = NULL;
    HRESULT hr = uia->lpVtbl->GetFocusedElement(uia, &el);
    if (FAILED(hr) || !el) return NULL;

    IUnknown *unk = NULL;
    hr = el->lpVtbl->GetCurrentPattern(el, UIA_TextPatternId, &unk);
    el->lpVtbl->Release(el);
    if (FAILED(hr) || !unk) return NULL;

    IUIAutomationTextPattern *pat = NULL;
    hr = unk->lpVtbl->QueryInterface(unk, &IID_IUIAutomationTextPattern, (void **)&pat);
    unk->lpVtbl->Release(unk);
    if (FAILED(hr) || !pat) return NULL;

    IUIAutomationTextRangeArray *arr = NULL;
    hr = pat->lpVtbl->GetSelection(pat, &arr);
    pat->lpVtbl->Release(pat);
    if (FAILED(hr) || !arr) return NULL;

    int n = 0;
    arr->lpVtbl->get_Length(arr, &n);

    WBUF b = {0};
    for (int i = 0; i < n; ++i) {
        IUIAutomationTextRange *r = NULL;
        if (FAILED(arr->lpVtbl->GetElement(arr, i, &r)) || !r) continue;
        BSTR t = NULL;
        if (SUCCEEDED(r->lpVtbl->GetText(r, -1, &t)) && t) {
            wbuf_push(&b, t, (size_t)SysStringLen(t));
            SysFreeString(t);
        }
        r->lpVtbl->Release(r);
    }
    arr->lpVtbl->Release(arr);

    if (!b.p) return NULL;

    /* 首尾空白去掉，对齐 PowerShell 的 .Trim() */
    size_t a = 0, z = b.len;
    while (a < z && (b.p[a] == L' ' || b.p[a] == L'\t' || b.p[a] == L'\r' ||
                     b.p[a] == L'\n' || b.p[a] == 0x3000 || b.p[a] == 0xFEFF)) a++;
    while (z > a && (b.p[z-1] == L' ' || b.p[z-1] == L'\t' || b.p[z-1] == L'\r' ||
                     b.p[z-1] == L'\n' || b.p[z-1] == 0x3000 || b.p[z-1] == 0xFEFF)) z--;
    if (z == a) { free(b.p); return NULL; }

    WCHAR *out = (WCHAR *)malloc((z - a + 1) * sizeof(WCHAR));
    if (!out) { free(b.p); return NULL; }
    memcpy(out, b.p + a, (z - a) * sizeof(WCHAR));
    out[z - a] = L'\0';
    free(b.p);
    return out;
}

/* ---------------- UIA 焦点事件订阅（让 UiaClientsAreListening 为真） ---------------- */

static HRESULT STDMETHODCALLTYPE fh_qi(IUIAutomationFocusChangedEventHandler *This,
                                       REFIID riid, void **ppv) {
    if (!ppv) return E_POINTER;
    *ppv = NULL;
    if (IsEqualIID(riid, &IID_IUnknown) ||
        IsEqualIID(riid, &IID_IUIAutomationFocusChangedEventHandler)) {
        *ppv = This;
        return S_OK;
    }
    return E_NOINTERFACE;
}

static ULONG STDMETHODCALLTYPE fh_addref(IUIAutomationFocusChangedEventHandler *This) {
    (void)This;
    return 1;
}

static ULONG STDMETHODCALLTYPE fh_release(IUIAutomationFocusChangedEventHandler *This) {
    (void)This;
    return 1;
}

/* 什么都不做。订阅本身就够了。 */
static HRESULT STDMETHODCALLTYPE fh_focus(IUIAutomationFocusChangedEventHandler *This,
                                          IUIAutomationElement *sender) {
    (void)This;
    (void)sender;
    return S_OK;
}

static IUIAutomationFocusChangedEventHandlerVtbl fh_vtbl = {
    fh_qi, fh_addref, fh_release, fh_focus
};
static IUIAutomationFocusChangedEventHandler fh_obj = { &fh_vtbl };

/**
 * 专职线程：STA + 消息循环。
 * UIA 事件回调必须由 STA 上的消息循环投递，所以这条线程只负责
 * 「挂着订阅、活着抽消息」，不做别的事。
 */
static DWORD WINAPI uia_listener_thread(LPVOID param) {
    (void)param;
    HRESULT hr = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
    if (FAILED(hr)) return 0;

    IUIAutomation *uia = NULL;
    hr = CoCreateInstance(&CLSID_CUIAutomation, NULL, CLSCTX_INPROC_SERVER,
                          &IID_IUIAutomation, (void **)&uia);
    if (SUCCEEDED(hr) && uia) {
        HRESULT h2 = uia->lpVtbl->AddFocusChangedEventHandler(uia, NULL, &fh_obj);
        if (FAILED(h2)) {
            fprintf(stderr, "[sel] AddFocusChangedEventHandler failed 0x%08lx\n",
                    (unsigned long)h2);
        }
        /* uia 故意不 Release：事件订阅要一直活着 */
    } else {
        fprintf(stderr, "[sel] CoCreateInstance(CUIAutomation) failed 0x%08lx\n",
                (unsigned long)hr);
    }

    MSG msg;
    while (GetMessageW(&msg, NULL, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    return 0;
}

/* ---------------- 事件构造 ---------------- */

static void fg_class(WCHAR *out, size_t cap) {
    out[0] = L'\0';
    HWND h = GetForegroundWindow();
    if (!h) return;
    GetClassNameW(h, out, (int)cap);
}

/** 与 selection-watch.ps1 的输出逐字节同构 */
static void emit_select(long x, long y, const WCHAR *text) {
    WCHAR cls[256];
    fg_class(cls, 256);

    char esc_cls[SEL_LINE_MAX];
    json_escape_w(cls, esc_cls, sizeof(esc_cls));

    char line[SEL_LINE_MAX * 2 + 256];
    if (text && *text) {
        char esc_txt[SEL_LINE_MAX];
        json_escape_w(text, esc_txt, sizeof(esc_txt));
        snprintf(line, sizeof(line),
                 "{\"type\":\"select\",\"x\":%ld,\"y\":%ld,\"cls\":\"%s\",\"text\":\"%s\"}",
                 x, y, esc_cls, esc_txt);
    } else {
        snprintf(line, sizeof(line),
                 "{\"type\":\"select\",\"x\":%ld,\"y\":%ld,\"cls\":\"%s\",\"text\":null}",
                 x, y, esc_cls);
    }
    out_line(line);
}

static void emit_sel_reply(void) {
    WCHAR *t = read_uia_selection(g_uia);
    char esc[SEL_LINE_MAX];
    char line[SEL_LINE_MAX + 64];
    if (t && *t) {
        json_escape_w(t, esc, sizeof(esc));
        snprintf(line, sizeof(line), "{\"ok\":true,\"text\":\"%s\"}", esc);
    } else {
        snprintf(line, sizeof(line), "{\"ok\":true,\"text\":null}");
    }
    out_line(line);
    free(t);
}

/* ---------------- stdin 协议 ---------------- */

static DWORD WINAPI stdin_thread(LPVOID param) {
    (void)param;
    char in[512];
    while (fgets(in, (int)sizeof(in), stdin)) {
        const char *cmd = strstr(in, "\"cmd\"");
        if (!cmd) continue;
        cmd = strchr(cmd, ':');
        if (!cmd) continue;
        cmd++;
        while (*cmd == ' ' || *cmd == '"') cmd++;

        if (strncmp(cmd, "quit", 4) == 0) {
            out_line("{\"ok\":true,\"bye\":true}");
            InterlockedExchange(&g_quit, 1);
            return 0;
        } else if (strncmp(cmd, "sel", 3) == 0) {
            InterlockedExchange(&g_sel_request, 1);
        } else if (strncmp(cmd, "ping", 4) == 0) {
            out_line("{\"ok\":true,\"pong\":true}");
        } else {
            out_line("{\"ok\":false,\"error\":\"unknown cmd\"}");
        }
    }
    /* stdin 被关掉 = 父进程没了，跟着退 */
    InterlockedExchange(&g_quit, 1);
    return 0;
}

/* ---------------- 主循环 ---------------- */

static void serve_loop(void) {
    int   left_down = 0;
    long  down_x = 0, down_y = 0;
    WCHAR last_text[512];
    DWORD last_emit_at = 0;
    POINT pt;

    last_text[0] = L'\0';

    while (!g_quit) {
        if (g_sel_request) {
            InterlockedExchange(&g_sel_request, 0);
            emit_sel_reply();
        }

        int pressed = (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0;
        GetCursorPos(&pt);

        if (pressed && !left_down) {
            left_down = 1;
            down_x = pt.x;
            down_y = pt.y;
        } else if (!pressed && left_down) {
            left_down = 0;
            long dx = pt.x - down_x;
            long dy = pt.y - down_y;
            /* 比较平方，省掉 math.h / libm 依赖 */
            if (dx * dx + dy * dy > SEL_DRAG_PX * SEL_DRAG_PX) {
                Sleep(SEL_SETTLE_MS);   /* 等选区在目标应用里落定 */

                WCHAR *text = read_uia_selection(g_uia);
                DWORD now = GetTickCount();
                if (text && *text) {
                    /* 同一段文字 4 秒内不重复弹（PowerShell 版同一策略） */
                    int dup = (wcscmp(text, last_text) == 0) &&
                              (now - last_emit_at) < SEL_DEDUPE_MS;
                    if (!dup) {
                        wcsncpy_s(last_text, 512, text, _TRUNCATE);
                        last_emit_at = now;
                        emit_select(pt.x, pt.y, text);
                    }
                } else {
                    /* UIA 读不到（Chromium / Electron 默认不开无障碍树、网页、Office、微信）
                       —— 推 text:null，由主进程走剪贴板降级 */
                    last_emit_at = now;
                    emit_select(pt.x, pt.y, NULL);
                }
                free(text);
            }
        }

        Sleep(SEL_POLL_MS);
    }
}

/* ---------------- 一次性自检 ---------------- */

static int sel_once(void) {
    HRESULT hr = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
    if (FAILED(hr)) {
        fprintf(stderr, "[sel] CoInitializeEx failed 0x%08lx\n", (unsigned long)hr);
        return 1;
    }

    IUIAutomation *uia = NULL;
    hr = CoCreateInstance(&CLSID_CUIAutomation, NULL, CLSCTX_INPROC_SERVER,
                          &IID_IUIAutomation, (void **)&uia);
    if (FAILED(hr) || !uia) {
        fprintf(stderr, "[sel] CoCreateInstance(CUIAutomation) failed 0x%08lx\n",
                (unsigned long)hr);
        return 1;
    }

    /* 同常驻模式：先挂焦点订阅，否则 Chromium 不开无障碍树，网页选区读不到 */
    uia->lpVtbl->AddFocusChangedEventHandler(uia, NULL, &fh_obj);

    /* 给订阅一点生效时间，同时把消息抽干 */
    for (int i = 0; i < 30; ++i) {
        MSG msg;
        while (PeekMessageW(&msg, NULL, 0, 0, PM_REMOVE)) {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        Sleep(10);
    }

    WCHAR *t = read_uia_selection(uia);
    if (t && *t) {
        char esc[SEL_LINE_MAX];
        json_escape_w(t, esc, sizeof(esc));
        printf("{\"ok\":true,\"text\":\"%s\"}\n", esc);
    } else {
        printf("{\"ok\":true,\"text\":null}\n");
    }
    free(t);
    return 0;
}

int main(int argc, char **argv) {
    /* 二进制模式：避免 \n 被翻译成 \r\n，让对端按 \n 切行时留下尾巴。 */
    _setmode(_fileno(stdout), _O_BINARY);
    _setmode(_fileno(stdin), _O_BINARY);

    if (argc < 2) {
        fprintf(stderr, "usage: orb-selection --serve | --sel | --help\n");
        return 2;
    }
    if (_stricmp(argv[1], "--help") == 0) {
        printf("usage: orb-selection [--serve|--sel|--help]\n");
        return 2;
    }
    if (_stricmp(argv[1], "--sel") == 0) return sel_once();
    if (_stricmp(argv[1], "--serve") != 0) {
        fprintf(stderr, "unknown mode: %s\n", argv[1]);
        return 2;
    }

    InitializeCriticalSection(&g_out_lock);

    /* 主线程 MTA：直接对外发 UIA 调用 */
    HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    if (FAILED(hr)) {
        fprintf(stderr, "[sel] CoInitializeEx failed 0x%08lx\n", (unsigned long)hr);
        return 1;
    }

    hr = CoCreateInstance(&CLSID_CUIAutomation, NULL, CLSCTX_INPROC_SERVER,
                          &IID_IUIAutomation, (void **)&g_uia);
    if (FAILED(hr) || !g_uia) {
        /* 不判失败：取词会退化成"读不到"，主进程仍有剪贴板降级路径 */
        fprintf(stderr, "[sel] 建 UIAutomation 失败 0x%08lx，UIA 取词不可用"
                        "（仍会推事件，由主进程走剪贴板降级）\n", (unsigned long)hr);
        g_uia = NULL;
    }

    HANDLE lth = CreateThread(NULL, 0, uia_listener_thread, NULL, 0, &g_listener_tid);
    HANDLE sth = CreateThread(NULL, 0, stdin_thread, NULL, 0, NULL);

    out_line("{\"ok\":true,\"ready\":true}");
    serve_loop();

    if (g_listener_tid) PostThreadMessageW(g_listener_tid, WM_QUIT, 0, 0);
    if (lth) { WaitForSingleObject(lth, 600); CloseHandle(lth); }
    if (sth) { WaitForSingleObject(sth, 600); CloseHandle(sth); }
    return 0;
}
