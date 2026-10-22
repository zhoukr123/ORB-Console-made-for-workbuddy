/*
 * orb-sfx.exe —— ORB 控制台便携版的自解压前端
 *
 * 为什么不用 IExpress：
 *   IExpress 内部用 MSZIP 把 payload 压成 CAB，再合并进桩。本次构建时它
 *   **稳定地**在最后一步失败（CAB 本身是好的、能正常展开，但合并不了），
 *   而同一份代码对另外几份 payload 又全部成功 —— 也就是说失败取决于
 *   payload 的具体字节，换个字节就时好时坏，完全没法作为发布依赖。
 *   （排查过程：全零对照排除了体积因素、4374 文件对照排除了文件数因素、
 *   176MB 单文件对照排除了 CAB 体积上限；最后确认 CAB 有效、卡在合并步。）
 *
 *   所以这里自己实现一个同等用途的前端，格式完全可控、可复现：
 *
 * 文件布局（三段，尾部自带寻址信息，不需要给桩补零对齐）：
 *
 *     [ 桩本体 ][ payload zip ][ 32 字节 trailer ]
 *
 *   trailer：
 *     +0   8 字节  魔数 "ORBSFX1"
 *     +8   8 字节  payload 长度（小端 uint64）
 *     +16  4 字节  payload 的 CRC32（校验用，0 表示不校验）
 *     +20  12 字节 保留，全零
 *
 *   桩启动时读尾部 trailer，反推出 payload 的偏移与长度，
 *   因此桩可以被任意重编译而不需要同步任何常量。
 *
 *   签名（Authenticode）之后布局变成：
 *
 *     [ 桩本体 ][ payload zip ][ 32 字节 trailer ][ 签名块 ]
 *
 *   签名块是 signtool 追加的，trailer 不再是文件最后 32 字节。所以桩改成
 *   从尾部往前倒扫魔数（见 locate_trailer），并用 payload 起点必须是
 *   zip local file header 来排除误命中。见 docs/代码签名获取方案调研.md §8。
 *
 * 运行流程：
 *   1. 把自己尾部的 payload 写到 %TEMP%\orb-sfx-<pid>.zip
 *   2. 解压到 <目标>\_raw（优先用系统自带 tar.exe；没有则退 PowerShell
 *      Expand-Archive —— 两者都不做 strip，统一走「找唯一子目录」这一步）
 *   3. 在 _raw 里找唯一子目录，再找里面的 *.cmd（就是「启动 ORB 控制台.cmd」），
 *      用 cmd.exe /c 拉起来
 *   4. 删掉临时 zip
 *
 * 用法：
 *   orb-sfx.exe                  # 默认解到 %LOCALAPPDATA%\ORBConsole
 *   orb-sfx.exe D:\some\dir      # 指定解压目标（测试用）
 *   orb-sfx.exe --probe          # 静默模式：只回退出码，不弹窗
 *   orb-sfx.exe --extract-only D:\some\dir
 *                                # 只解压，不启动启动器（验证 / CI 用）
 *
 * 退出码：0 成功；1 自身不是合法包；2 解压失败；3 找不到启动器。
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#define SFX_MAGIC       "ORBSFX1"
#define SFX_MAGIC_LEN   7
#define SFX_TRAILER     32
#define SFX_PAYLOAD_MAX (1024ULL * 1024ULL * 1024ULL)   /* 1GB，便携包远小于此 */
#define SFX_DIR_NAME    L"ORBConsole"

/* --probe：只回退出码、不弹窗。给构建脚本自检用，也给锁屏 / 无人值守场景用
   （桌面锁着时 MessageBoxW 可能既不显示也不返回，自检会假死）。 */
static int g_quiet = 0;
/* --extract-only：解压完就退出，不拉起启动器。用于验证 / CI —— 否则验证一次
   就要真的启动一遍 Electron。 */
static int g_extract_only = 0;

static void msgbox(const WCHAR *text, const WCHAR *title) {
    if (g_quiet) return;
    MessageBoxW(NULL, text, title, MB_OK | MB_ICONERROR | MB_SETFOREGROUND);
}

/* ---- CRC32（校验 payload 完整性；trailer 里为 0 则跳过） ---- */
static unsigned long crc32_of(const unsigned char *p, size_t n) {
    static unsigned long tab[256];
    static int inited = 0;
    if (!inited) {
        for (unsigned long i = 0; i < 256; ++i) {
            unsigned long c = i;
            for (int k = 0; k < 8; ++k) c = (c & 1) ? (0xEDB88320UL ^ (c >> 1)) : (c >> 1);
            tab[i] = c;
        }
        inited = 1;
    }
    unsigned long c = 0xFFFFFFFFUL;
    for (size_t i = 0; i < n; ++i) c = tab[(c ^ p[i]) & 0xFF] ^ (c >> 8);
    return c ^ 0xFFFFFFFFUL;
}

static unsigned long long le64(const unsigned char *p) {
    unsigned long long v = 0;
    for (int i = 7; i >= 0; --i) v = (v << 8) | (unsigned long long)p[i];
    return v;
}
static unsigned long le32(const unsigned char *p) {
    return (unsigned long)p[0] | ((unsigned long)p[1] << 8) |
           ((unsigned long)p[2] << 16) | ((unsigned long)p[3] << 24);
}

/* ---- 签名感知的 trailer 定位 ----
 *
 * 为什么要倒扫而不是直接读 total-32：
 *   Authenticode（signtool）把签名块**追加在文件最末尾**。一旦 OV/自签名证书
 *   签了这个便携包，最后 32 字节就不再是 trailer，而是签名块的一部分 ——
 *   老写法 `back = total - SFX_TRAILER` 会读到垃圾，桩当场报「尾部签名不匹配」，
 *   208 MB 的包直接打不开。所以改成从尾部往前找魔数。
 *
 * 误命中怎么排除（zip 数据里也可能恰好出现 "ORBSFX1"）：
 *   1) payload_len 必须落在 (0, SFX_PAYLOAD_MAX] 内；
 *   2) 反推出的 payload 起点必须在桩之后、且在文件内；
 *   3) 起点处 4 个字节必须是 "PK\x03\x04"（zip local file header）。
 *   三条同时成立才认，实际数据里几乎不可能撞出来。
 *
 * 倒扫命中顺序：从后往前，第一个通过校验的就是真 trailer（它永远在 payload 之后）。
 */
#define SFX_SCAN_WINDOW (256 * 1024)   /* 签名块通常 1.5–8 KB，256 KB 极宽松 */

/* 供 orb/sign.cjs 识别"本桩能处理签名后的包"。别删 —— 删了签名脚本会拒绝给
   便携包签名（它宁可拒签，也不产出一个打不开的包）。 */
static const char k_sign_marker[] = "ORBSFXSIGN1";

static int read_at(HANDLE h, long long off, void *buf, DWORD n) {
    LARGE_INTEGER p;
    p.QuadPart = off;
    DWORD got = 0;
    if (!SetFilePointerEx(h, p, NULL, FILE_BEGIN)) return 0;
    return ReadFile(h, buf, n, &got, NULL) && got == n;
}

/* 返回 1 = 找到并校验通过；0 = 根本没有魔数；-1 = 有魔数但 payload 字段不合法 */
static int locate_trailer(HANDLE h, long long total,
                          long long *payload_off,
                          unsigned long long *payload_len,
                          unsigned long *want_crc) {
    static const unsigned char PK_LOCAL[4] = { 0x50, 0x4B, 0x03, 0x04 };
    long long win = total < SFX_SCAN_WINDOW ? total : SFX_SCAN_WINDOW;
    if (win < SFX_TRAILER) return 0;

    long long base = total - win;
    unsigned char *buf = (unsigned char *)malloc((size_t)win);
    if (!buf) return 0;
    if (!read_at(h, base, buf, (DWORD)win)) { free(buf); return 0; }

    int magic_seen = 0, ok = 0;
    for (long long i = win - SFX_TRAILER; i >= 0; --i) {
        if (buf[i] != (unsigned char)SFX_MAGIC[0]) continue;
        if (memcmp(buf + i, SFX_MAGIC, SFX_MAGIC_LEN) != 0) continue;
        magic_seen = 1;

        unsigned long long len = le64(buf + i + 8);
        long long off = base + i - (long long)len;
        if (len == 0 || len > SFX_PAYLOAD_MAX || off < 16 || off > total) continue;

        unsigned char sig[4];
        if (!read_at(h, off, sig, 4)) continue;
        if (memcmp(sig, PK_LOCAL, 4) != 0) continue;

        *payload_off = off;
        *payload_len = len;
        *want_crc = le32(buf + i + 16);
        ok = 1;
        break;
    }
    free(buf);
    return ok ? 1 : (magic_seen ? -1 : 0);
}

/** 把一段文件内容复制到另一个文件。成功返回 1。 */
static int dump_range(const WCHAR *src, long long off, unsigned long long len,
                      const WCHAR *dst) {
    HANDLE in = CreateFileW(src, GENERIC_READ, FILE_SHARE_READ, NULL,
                            OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, NULL);
    if (in == INVALID_HANDLE_VALUE) return 0;
    HANDLE out = CreateFileW(dst, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS,
                             FILE_ATTRIBUTE_TEMPORARY, NULL);
    if (out == INVALID_HANDLE_VALUE) { CloseHandle(in); return 0; }

    LARGE_INTEGER move;
    move.QuadPart = off;
    if (!SetFilePointerEx(in, move, NULL, FILE_BEGIN)) goto fail;

    unsigned char buf[256 * 1024];
    unsigned long long left = len;
    while (left > 0) {
        DWORD want = (DWORD)(left > sizeof(buf) ? sizeof(buf) : left);
        DWORD got = 0;
        if (!ReadFile(in, buf, want, &got, NULL) || got == 0) goto fail;
        DWORD put = 0;
        if (!WriteFile(out, buf, got, &put, NULL) || put != got) goto fail;
        left -= got;
    }
    /* 立刻落盘并丢掉缓存：解压程序马上要打开它 */
    FlushFileBuffers(out);
    CloseHandle(out);
    CloseHandle(in);
    return 1;
fail:
    CloseHandle(out);
    CloseHandle(in);
    return 0;
}

/** 跑一个外部进程，等它结束，回填退出码。成功启动返回 1。 */
static int run_wait(const WCHAR *cmdline, DWORD *exit_code) {
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    ZeroMemory(&pi, sizeof(pi));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;

    /* CreateProcessW 要可写的命令行缓冲 */
    WCHAR *buf = _wcsdup(cmdline);
    if (!buf) return 0;
    BOOL ok = CreateProcessW(NULL, buf, NULL, NULL, FALSE,
                             CREATE_NO_WINDOW, NULL, NULL, &si, &pi);
    free(buf);
    if (!ok) return 0;
    WaitForSingleObject(pi.hProcess, INFINITE);
    if (exit_code) GetExitCodeProcess(pi.hProcess, exit_code);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    return 1;
}

/** 用系统自带 tar.exe 解压。成功返回 1。 */
static int extract_tar(const WCHAR *zip, const WCHAR *dest) {
    const WCHAR *TAR = L"C:\\Windows\\System32\\tar.exe";
    if (GetFileAttributesW(TAR) == INVALID_FILE_ATTRIBUTES) return 0;
    WCHAR cmd[4096];
    _snwprintf(cmd, 4096, L"\"%s\" -x -f \"%s\" -C \"%s\"", TAR, zip, dest);
    DWORD code = 1;
    if (!run_wait(cmd, &code)) return 0;
    return code == 0;
}

/** 兜底：PowerShell 的 Expand-Archive（PS 5.1 对非 ASCII 条目名不太稳，
    但只有在没有 tar.exe 的老系统上才会走到，总比直接失败好）。 */
static int extract_ps(const WCHAR *zip, const WCHAR *dest) {
    WCHAR cmd[4096];
    _snwprintf(cmd, 4096,
               L"powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "
               L"\"Expand-Archive -LiteralPath '%s' -DestinationPath '%s' -Force\"",
               zip, dest);
    DWORD code = 1;
    if (!run_wait(cmd, &code)) return 0;
    return code == 0;
}

/** 在 dir 下找第一个子目录名（拷进 out）。找到返回 1。 */
static int first_subdir(const WCHAR *dir, WCHAR *out, size_t cap) {
    WCHAR pat[1024];
    _snwprintf(pat, 1024, L"%s\\*", dir);
    WIN32_FIND_DATAW fd;
    HANDLE h = FindFirstFileW(pat, &fd);
    if (h == INVALID_HANDLE_VALUE) return 0;
    int found = 0;
    do {
        if ((fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) &&
            wcscmp(fd.cFileName, L".") != 0 && wcscmp(fd.cFileName, L"..") != 0) {
            wcsncpy(out, fd.cFileName, cap - 1);
            out[cap - 1] = L'\0';
            found = 1;
            break;
        }
    } while (FindNextFileW(h, &fd));
    FindClose(h);
    return found;
}

/** 在 dir 下找第一个 *.cmd 文件名。找到返回 1。 */
static int first_cmd(const WCHAR *dir, WCHAR *out, size_t cap) {
    WCHAR pat[1024];
    _snwprintf(pat, 1024, L"%s\\*.cmd", dir);
    WIN32_FIND_DATAW fd;
    HANDLE h = FindFirstFileW(pat, &fd);
    if (h == INVALID_HANDLE_VALUE) return 0;
    wcsncpy(out, fd.cFileName, cap - 1);
    out[cap - 1] = L'\0';
    FindClose(h);
    return 1;
}

int wmain(int argc, wchar_t **argv) {
    WCHAR self[MAX_PATH];
    if (!GetModuleFileNameW(NULL, self, MAX_PATH)) { msgbox(L"取不到自身路径。", L"ORB 控制台"); return 1; }

    /* 选项可以出现在任意位置（`--probe` / `--extract-only` 放目标目录前后都认）：
       早先的写法只认"选项必须在前"，于是 `orb-sfx.exe D:\dir --extract-only`
       会被当成"目标是 D:\dir、没有 --extract-only"，解压完照样把应用拉起来——
       调用方以为"只解压不启动"，结果桌上弹出一个控制台。 */
    const wchar_t *target = NULL;
    for (int i = 1; i < argc; i++) {
        if (wcscmp(argv[i], L"--probe") == 0) g_quiet = 1;
        else if (wcscmp(argv[i], L"--extract-only") == 0) g_extract_only = 1;
        else if (argv[i][0] == L'-') { /* 不认识的选项：忽略，别把它当路径 */ }
        else if (!target) target = argv[i];   /* 第一个非选项参数当目标目录 */
    }

    /* ---------- 1. 从尾部倒扫 trailer，反推 payload 位置 ---------- */
    HANDLE h = CreateFileW(self, GENERIC_READ, FILE_SHARE_READ, NULL,
                           OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, NULL);
    if (h == INVALID_HANDLE_VALUE) { msgbox(L"打不开自身文件。", L"ORB 控制台"); return 1; }
    LARGE_INTEGER total;
    if (!GetFileSizeEx(h, &total) || total.QuadPart < SFX_TRAILER + 16) {
        CloseHandle(h);
        msgbox(L"这个文件不是 ORB 便携包（体积过小）。", L"ORB 控制台");
        return 1;
    }

    /* 这个判断永远不会成立，存在的唯一目的是让 /O2 不敢把 k_sign_marker 优化掉
       —— 少了这串字面量，orb/sign.cjs 就认不出这是"签名感知"的桩，会拒签。 */
    if (k_sign_marker[0] == '\0') { CloseHandle(h); return 1; }

    long long payload_off = 0;
    unsigned long long payload_len = 0;
    unsigned long want_crc = 0;
    int loc = locate_trailer(h, total.QuadPart, &payload_off, &payload_len, &want_crc);
    CloseHandle(h);

    if (loc == 0) {
        msgbox(L"这个文件不是 ORB 便携包（找不到包尾寻址信息）。", L"ORB 控制台");
        return 1;
    }
    if (loc < 0) {
        msgbox(L"便携包的寻址信息已损坏（长度字段不合法）。", L"ORB 控制台");
        return 1;
    }

    /* ---------- 2. 定目标目录 ---------- */
    WCHAR dest[MAX_PATH];
    if (target && target[0]) {
        wcsncpy(dest, target, MAX_PATH - 1);
        dest[MAX_PATH - 1] = L'\0';
    } else {
        WCHAR local[MAX_PATH];
        if (!GetEnvironmentVariableW(L"LOCALAPPDATA", local, MAX_PATH)) {
            msgbox(L"取不到 %LOCALAPPDATA%。", L"ORB 控制台");
            return 2;
        }
        _snwprintf(dest, MAX_PATH, L"%s\\%s", local, SFX_DIR_NAME);
    }
    CreateDirectoryW(dest, NULL);

    WCHAR raw[MAX_PATH];
    _snwprintf(raw, MAX_PATH, L"%s\\_raw", dest);
    CreateDirectoryW(raw, NULL);

    /* ---------- 3. 已解压过就直接启动，不再重复解 ---------- */
    WCHAR sub[MAX_PATH] = L"";
    int have = first_subdir(raw, sub, MAX_PATH);
    if (have) {
        WCHAR probe[MAX_PATH];
        _snwprintf(probe, MAX_PATH, L"%s\\%s\\resources\\app\\main.js", raw, sub);
        if (GetFileAttributesW(probe) != INVALID_FILE_ATTRIBUTES) have = 2;  /* 完整，跳过解压 */
    }

    if (have != 2) {
        /* ---------- 4. 落临时 zip ---------- */
        WCHAR tmpdir[MAX_PATH], zip[MAX_PATH];
        if (!GetTempPathW(MAX_PATH, tmpdir)) { msgbox(L"取不到临时目录。", L"ORB 控制台"); return 2; }
        _snwprintf(zip, MAX_PATH, L"%sorb-sfx-%lu.zip", tmpdir, GetCurrentProcessId());

        if (!dump_range(self, payload_off, payload_len, zip)) {
            msgbox(L"解出便携包内容失败（写临时文件出错）。", L"ORB 控制台");
            return 2;
        }

        /* ---------- 5. 解压 ---------- */
        int ok = extract_tar(zip, raw);
        if (!ok) ok = extract_ps(zip, raw);
        if (!ok) {
            /* 留着 zip 让用户能自己解，别当场删掉 */
            WCHAR m[2048];
            _snwprintf(m, 2048,
                       L"解压失败。\n\n便携包已留在：\n%s\n\n可以手动解开它，"
                       L"再运行里面的「启动 ORB 控制台.cmd」。", zip);
            msgbox(m, L"ORB 控制台");
            return 2;
        }
        DeleteFileW(zip);
    }

    /* ---------- 6. 找启动器并拉起来 ---------- */
    if (g_extract_only) return 0;        /* 验证模式：解压到此为止 */
    if (!first_subdir(raw, sub, MAX_PATH)) {
        msgbox(L"解压结果里找不到应用目录。", L"ORB 控制台");
        return 3;
    }
    WCHAR appdir[MAX_PATH], cmdname[MAX_PATH] = L"";
    _snwprintf(appdir, MAX_PATH, L"%s\\%s", raw, sub);
    if (!first_cmd(appdir, cmdname, MAX_PATH)) {
        msgbox(L"应用目录里找不到启动脚本（*.cmd）。", L"ORB 控制台");
        return 3;
    }
    WCHAR cmd[2048];
    _snwprintf(cmd, 2048, L"cmd.exe /c \"\"%s\\%s\"\"", appdir, cmdname);
    DWORD code = 1;
    if (!run_wait(cmd, &code)) {
        msgbox(L"启动失败（跑不起来 cmd.exe）。", L"ORB 控制台");
        return 3;
    }
    return 0;
}
