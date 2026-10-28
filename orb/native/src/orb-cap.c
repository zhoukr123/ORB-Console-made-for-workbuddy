/* ---------------------------------------------------------------
 * orb-cap.exe —— ORB 原生录屏 helper（Stage 1：DXGI 复制 + MF H.264 直出 MP4）
 * ---------------------------------------------------------------
 * 为什么要有这个 exe：Electron 的 MediaRecorder 只能出 VP9/WebM（而且成片
 * 无 mvhd.duration、要额外补齐），要做「体积小、能直接分享的 MP4」只能走系统
 * 自带的编码器。DXGI Desktop Duplication 拿帧 + Media Foundation SinkWriter
 * 直写 .mp4，全程零第三方依赖（系统组件），实测 2560×1600 @30fps 编码 ~9ms/帧。
 *
 * 用法：
 *   orb-cap.exe --out <绝对路径.mp4> [--fps 30] [--bitrate 6000000] [--display 0]
 *
 * stdin（每行一条，读一行做一件事；EOF 视为 stop，避免父进程异常退出后留半成品）：
 *   ping    → ok
 *   pause   → paused     暂停期间继续取帧但丢弃，不写样本
 *   resume  → resumed    时间戳按"已写帧数"算，暂停自动无缝，成片里没有空档
 *   stop    → 写完完整 MP4 后 done <bytes> <elapsedMs>，退出码 0
 *   abort   → 释放并删除半成品后 aborted，退出码 0
 *
 * stdout 协议（UTF-8，每行以 \n 结尾并立即 flush；主进程按行解析）：
 *   ready <w> <h> <fps>      已 BeginWriting，可以开始计时（首帧对齐点）
 *   frame <n>                已写入帧数，**每秒最多一行**（不是每帧一行）
 *   done <bytes> <elapsedMs>            正常收尾
 *   done <bytes> <elapsedMs> <w> <h>    尺寸变化（切分辨率/解锁屏）导致换文件段时，
 *                                       末尾追加新尺寸，主进程据此新起一段
 *   aborted                  已删除半成品
 *   err <hrHex> <说明>       致命错误，进程随后以非 0 退出码退出（主进程回退 VP9）
 *
 * 实现要点（都是踩过坑的地方，改之前先读）：
 *  1) **CFR**：桌面静止时 DXGI 根本不给新帧，但 MP4 要恒定帧率，否则时长不对。
 *     所以按 nextDue 到点就写：没有新帧就重复上一帧（编码成极小的 P 帧，几乎不耗 CPU）。
 *     绝不用 VFR —— 那会让播放器把时长算成"最后一帧时间戳"。
 *  2) **时间戳**：t = 已写帧数 * (10^7 / fps)，100ns 单位。暂停不增计数，天然无缝。
 *  3) **ACCESS_LOST**（切分辨率 / 锁屏 / 全屏切换）：整条 duplication 作废，重建；
 *     连续失败 5 次才报 err。尺寸变了就收尾当前文件、done 里带新尺寸、以 0 退出
 *     （v1 不要求跨段无缝，主进程新起一个文件）。
 *  4) **每帧新建 MF 缓冲**：MF 会异步持有 sample，复用同一块内存会写出花屏。
 *  5) **DPI**：必须 PER_MONITOR_AWARE_V2，否则窗口坐标是虚拟化的、和复制缓冲区
 *     不是一个坐标系（Stage 0 探针就是被这个坑过）。
 *  6) **中文路径**：argv 是 GBK 转来的，会打坏路径 —— 用 CommandLineToArgvW
 *     直接取宽字符命令行。
 *  7) 失败一律 err + 非 0 退出，绝不静默（主进程要靠它回退）。
 *
 * v1 边界：只录主显示器（--display 0）、无音频、不分段续录、不分片。
 * 编译：powershell -File orb/native/build-cap.ps1
 * --------------------------------------------------------------- */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mferror.h>
#include <shellapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>
#include <stdarg.h>
#include <string.h>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "dxguid.lib")
#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mfreadwrite.lib")
#pragma comment(lib, "mfuuid.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "shell32.lib")

#define CAP_CMDQ 64          /* 命令队列长度（命令很少，够用） */
#define CAP_LINE 256         /* 单行命令长度上限 */
#define CAP_ACQ_MAX_MS 16    /* 单次等待新帧的上限（≈ 一帧 @60fps） */
#define CAP_REBUILD_TRIES 5  /* ACCESS_LOST 连续重建次数上限 */

/* ---------------- 输出 ---------------- */
/* 每行都 flush：主进程是流式按行解析的，攒在缓冲里等于"没有输出"。 */
static void emit(const char* fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vprintf(fmt, ap);
  va_end(ap);
  putchar('\n');
  fflush(stdout);
}

/* 致命错误统一格式：err <hrHex> <说明> */
static void emitErr(long hr, const char* fmt, ...) {
  char msg[512];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(msg, sizeof(msg), fmt, ap);
  va_end(ap);
  printf("err %08lX %s\n", (unsigned long)hr, msg);
  fflush(stdout);
}

/* 宽字符 → UTF-8（日志里带路径时用；控制台已设 UTF-8 代码页） */
static void w2u8(const WCHAR* w, char* out, size_t cap) {
  if (!out || cap == 0) return;
  out[0] = 0;
  if (!w) return;
  if (WideCharToMultiByte(CP_UTF8, 0, w, -1, out, (int)cap, NULL, NULL) <= 0) out[0] = 0;
}

/* ---------------- stdin 命令队列 ----------------
 * 帧循环不能被 stdin 阻塞（阻塞 = 掉帧 = CFR 补一堆重复帧），所以读命令放
 * 独立线程，主线程每轮只做无锁检查。队列用临界区保护 —— 命令频率极低
 * （一次录制几十条），临界区开销可以忽略。
 * ---------------------------------------------- */
typedef enum {
  CMD_NONE = 0,
  CMD_PING,
  CMD_PAUSE,
  CMD_RESUME,
  CMD_STOP,
  CMD_ABORT,
  CMD_UNKNOWN
} CapCmd;

static CRITICAL_SECTION g_qLock;
static CapCmd g_q[CAP_CMDQ];
static int g_qHead = 0;    /* 读位置 */
static int g_qTail = 0;    /* 写位置 */
static int g_qCount = 0;

static void pushCmd(CapCmd c) {
  EnterCriticalSection(&g_qLock);
  if (g_qCount < CAP_CMDQ) {
    g_q[g_qTail] = c;
    g_qTail = (g_qTail + 1) % CAP_CMDQ;
    g_qCount++;
  }
  /* 队列满就丢弃：命令只可能是重复的 pause/resume，丢掉不影响最终状态 */
  LeaveCriticalSection(&g_qLock);
}

static CapCmd popCmd(void) {
  CapCmd c = CMD_NONE;
  EnterCriticalSection(&g_qLock);
  if (g_qCount > 0) {
    c = g_q[g_qHead];
    g_qHead = (g_qHead + 1) % CAP_CMDQ;
    g_qCount--;
  }
  LeaveCriticalSection(&g_qLock);
  return c;
}

/* 只认小写原样命令（协议就是这么定的，不做大小写/别名兼容 —— 
   兼容会让"打错字却照跑"变成排查噩梦） */
static CapCmd parseCmd(const char* s) {
  if (!s) return CMD_NONE;
  while (*s == ' ' || *s == '\t') s++;
  char buf[CAP_LINE];
  size_t n = 0;
  while (s[n] && s[n] != ' ' && s[n] != '\t' && s[n] != '\r' && n < sizeof(buf) - 1) {
    buf[n] = s[n];
    n++;
  }
  buf[n] = 0;
  if (buf[0] == 0) return CMD_NONE;          /* 空行：忽略 */
  if (!strcmp(buf, "ping")) return CMD_PING;
  if (!strcmp(buf, "pause")) return CMD_PAUSE;
  if (!strcmp(buf, "resume")) return CMD_RESUME;
  if (!strcmp(buf, "stop")) return CMD_STOP;
  if (!strcmp(buf, "abort")) return CMD_ABORT;
  return CMD_UNKNOWN;
}

/* 读线程：阻塞读 stdin，按 \n 切行压进队列。
   EOF（父进程关了管道）→ 视作 stop：宁可正常收尾，也不要留一个没人管的进程
   和一个永远缺 moov 的半成品。 */
static DWORD WINAPI stdinReader(LPVOID param) {
  (void)param;
  HANDLE h = GetStdHandle(STD_INPUT_HANDLE);
  char chunk[256];
  char line[CAP_LINE];
  size_t lineLen = 0;
  for (;;) {
    DWORD got = 0;
    if (h == INVALID_HANDLE_VALUE || h == NULL) break;
    if (!ReadFile(h, chunk, (DWORD)sizeof(chunk), &got, NULL) || got == 0) break;
    for (DWORD i = 0; i < got; i++) {
      char c = chunk[i];
      if (c == '\n') {
        line[lineLen] = 0;
        CapCmd cmd = parseCmd(line);
        if (cmd != CMD_NONE) pushCmd(cmd);
        lineLen = 0;
      } else if (c == '\r') {
        /* 忽略：\r\n 与 \n 都支持 */
      } else if (lineLen < sizeof(line) - 1) {
        line[lineLen++] = c;
      }
      /* 超长行直接丢尾部：命令都很短，截断到 CAP_LINE 足够判前缀 */
    }
  }
  pushCmd(CMD_STOP);   /* EOF ⇒ 收尾 */
  return 0;
}

/* ---------------- 桌面复制上下文 ----------------
 * 把"设备 + 输出 + duplication + 暂存纹理"打成一包，ACCESS_LOST 时整包重建
 * （重建设备比只重建 duplication 贵不到哪去，但代码只有一条路径，少一类 bug）。
 * ---------------------------------------------- */
typedef struct {
  ID3D11Device* dev;
  ID3D11DeviceContext* ctx;
  IDXGIAdapter* adapter;
  IDXGIOutput* output;
  IDXGIOutput1* output1;
  IDXGIOutputDuplication* dupl;
  ID3D11Texture2D* staging;   /* GPU → CPU 的暂存纹理（D3D11_USAGE_STAGING） */
  UINT w;
  UINT h;
} Dup;

static void dupDestroy(Dup* d) {
  if (!d) return;
  if (d->staging) { d->staging->lpVtbl->Release(d->staging); d->staging = NULL; }
  if (d->dupl) { d->dupl->lpVtbl->Release(d->dupl); d->dupl = NULL; }
  if (d->output1) { d->output1->lpVtbl->Release(d->output1); d->output1 = NULL; }
  if (d->output) { d->output->lpVtbl->Release(d->output); d->output = NULL; }
  if (d->adapter) { d->adapter->lpVtbl->Release(d->adapter); d->adapter = NULL; }
  if (d->ctx) { d->ctx->lpVtbl->Release(d->ctx); d->ctx = NULL; }
  if (d->dev) { d->dev->lpVtbl->Release(d->dev); d->dev = NULL; }
  d->w = 0;
  d->h = 0;
}

static HRESULT dupCreate(Dup* d, int displayIndex) {
  ZeroMemory(d, sizeof(*d));
  D3D_FEATURE_LEVEL fl = 0;
  HRESULT hr = D3D11CreateDevice(NULL, D3D_DRIVER_TYPE_HARDWARE, NULL,
                                 D3D11_CREATE_DEVICE_BGRA_SUPPORT, NULL, 0,
                                 D3D11_SDK_VERSION, &d->dev, &fl, &d->ctx);
  if (FAILED(hr)) return hr;

  IDXGIDevice* dxgiDev = NULL;
  hr = d->dev->lpVtbl->QueryInterface(d->dev, &IID_IDXGIDevice, (void**)&dxgiDev);
  if (SUCCEEDED(hr)) {
    hr = dxgiDev->lpVtbl->GetAdapter(dxgiDev, &d->adapter);
    dxgiDev->lpVtbl->Release(dxgiDev);
  }
  if (SUCCEEDED(hr)) {
    hr = d->adapter->lpVtbl->EnumOutputs(d->adapter, (UINT)displayIndex, &d->output);
  }
  if (SUCCEEDED(hr)) {
    hr = d->output->lpVtbl->QueryInterface(d->output, &IID_IDXGIOutput1, (void**)&d->output1);
  }
  if (SUCCEEDED(hr)) {
    hr = d->output1->lpVtbl->DuplicateOutput(d->output1, (IUnknown*)d->dev, &d->dupl);
  }
  if (SUCCEEDED(hr)) {
    DXGI_OUTDUPL_DESC dd;
    ZeroMemory(&dd, sizeof(dd));
    d->dupl->lpVtbl->GetDesc(d->dupl, &dd);
    d->w = dd.ModeDesc.Width;
    d->h = dd.ModeDesc.Height;

    D3D11_TEXTURE2D_DESC td;
    ZeroMemory(&td, sizeof(td));
    td.Width = d->w;
    td.Height = d->h;
    td.MipLevels = 1;
    td.ArraySize = 1;
    td.Format = DXGI_FORMAT_B8G8R8A8_UNORM;   /* 与 MF 的 RGB32 一一对应 */
    td.SampleDesc.Count = 1;
    td.Usage = D3D11_USAGE_STAGING;
    td.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    hr = d->dev->lpVtbl->CreateTexture2D(d->dev, &td, NULL, &d->staging);
  }
  if (FAILED(hr)) dupDestroy(d);
  return hr;
}

/* ACCESS_LOST：整包重建，最多 CAP_REBUILD_TRIES 次。
   成功返回 S_OK；changed 回填"分辨率变了"（调用方据此收尾当前文件）。 */
static HRESULT dupRebuild(Dup* d, int* changed) {
  UINT oldW = d->w, oldH = d->h;
  HRESULT hr = E_FAIL;
  if (changed) *changed = 0;
  for (int i = 0; i < CAP_REBUILD_TRIES; i++) {
    dupDestroy(d);
    hr = dupCreate(d, 0);
    if (SUCCEEDED(hr)) {
      if (changed && (d->w != oldW || d->h != oldH)) *changed = 1;
      return S_OK;
    }
    Sleep(120);   /* 锁屏/切换分辨率的中途会连续失败，等一下再试 */
  }
  return hr;
}

/* ---------------- SinkWriter ----------------
 * 输出 H.264 / MP4，输入 RGB32（BGRA，和暂存纹理同格式 → 拷贝就是纯 memcpy）。
 * ---------------------------------------------- */
static HRESULT writerCreate(const WCHAR* path, UINT w, UINT h, int fps, int bitrate,
                            IMFSinkWriter** outWriter, DWORD* outStream) {
  *outWriter = NULL;
  *outStream = 0;

  IMFAttributes* attrs = NULL;
  HRESULT hr = MFCreateAttributes(&attrs, 2);
  if (FAILED(hr)) return hr;
  attrs->lpVtbl->SetUINT32(attrs, &MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, TRUE);
  /* 关掉限流：写样本不等编码器处理完，避免编码慢时把取帧线程拖住（CFR 靠补帧兜） */
  attrs->lpVtbl->SetUINT32(attrs, &MF_SINK_WRITER_DISABLE_THROTTLING, TRUE);

  IMFSinkWriter* writer = NULL;
  hr = MFCreateSinkWriterFromURL(path, NULL, attrs, &writer);
  attrs->lpVtbl->Release(attrs);
  if (FAILED(hr)) return hr;

  IMFMediaType* outT = NULL;
  IMFMediaType* inT = NULL;
  DWORD stream = 0;
  hr = MFCreateMediaType(&outT);
  if (SUCCEEDED(hr)) hr = outT->lpVtbl->SetGUID(outT, &MF_MT_MAJOR_TYPE, &MFMediaType_Video);
  if (SUCCEEDED(hr)) hr = outT->lpVtbl->SetGUID(outT, &MF_MT_SUBTYPE, &MFVideoFormat_H264);
  if (SUCCEEDED(hr)) hr = outT->lpVtbl->SetUINT32(outT, &MF_MT_AVG_BITRATE, (UINT32)bitrate);
  if (SUCCEEDED(hr)) hr = outT->lpVtbl->SetUINT32(outT, &MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
  if (SUCCEEDED(hr)) hr = outT->lpVtbl->SetUINT64(outT, &MF_MT_FRAME_SIZE, ((UINT64)w << 32) | h);
  if (SUCCEEDED(hr)) hr = outT->lpVtbl->SetUINT64(outT, &MF_MT_FRAME_RATE, ((UINT64)(UINT32)fps << 32) | 1);
  if (SUCCEEDED(hr)) hr = outT->lpVtbl->SetUINT64(outT, &MF_MT_PIXEL_ASPECT_RATIO, ((UINT64)1 << 32) | 1);
  if (SUCCEEDED(hr)) hr = writer->lpVtbl->AddStream(writer, outT, &stream);

  if (SUCCEEDED(hr)) hr = MFCreateMediaType(&inT);
  if (SUCCEEDED(hr)) hr = inT->lpVtbl->SetGUID(inT, &MF_MT_MAJOR_TYPE, &MFMediaType_Video);
  if (SUCCEEDED(hr)) hr = inT->lpVtbl->SetGUID(inT, &MF_MT_SUBTYPE, &MFVideoFormat_RGB32);
  if (SUCCEEDED(hr)) hr = inT->lpVtbl->SetUINT32(inT, &MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
  if (SUCCEEDED(hr)) hr = inT->lpVtbl->SetUINT64(inT, &MF_MT_FRAME_SIZE, ((UINT64)w << 32) | h);
  if (SUCCEEDED(hr)) hr = inT->lpVtbl->SetUINT64(inT, &MF_MT_FRAME_RATE, ((UINT64)(UINT32)fps << 32) | 1);
  if (SUCCEEDED(hr)) hr = inT->lpVtbl->SetUINT64(inT, &MF_MT_PIXEL_ASPECT_RATIO, ((UINT64)1 << 32) | 1);
  if (SUCCEEDED(hr)) hr = writer->lpVtbl->SetInputMediaType(writer, stream, inT, NULL);
  if (SUCCEEDED(hr)) hr = writer->lpVtbl->BeginWriting(writer);

  if (inT) inT->lpVtbl->Release(inT);
  if (outT) outT->lpVtbl->Release(outT);

  if (FAILED(hr)) {
    writer->lpVtbl->Release(writer);
    return hr;
  }
  *outWriter = writer;
  *outStream = stream;
  return S_OK;
}

/* 把暂存纹理的一帧写成一个 sample（t / dur 都是 100ns 单位）。
   每帧新建 MF 缓冲，不复用：MF 会异步持有 sample，复用同一块内存会写出花屏。 */
static HRESULT writeFrame(IMFSinkWriter* writer, DWORD stream, Dup* d,
                          UINT encW, UINT encH, LONGLONG t, LONGLONG dur) {
  D3D11_MAPPED_SUBRESOURCE map;
  HRESULT hr = d->ctx->lpVtbl->Map(d->ctx, (ID3D11Resource*)d->staging, 0,
                                   D3D11_MAP_READ, 0, &map);
  if (FAILED(hr)) return hr;

  const DWORD stride = encW * 4;
  const DWORD need = stride * encH;
  IMFMediaBuffer* buf = NULL;
  hr = MFCreateMemoryBuffer(need, &buf);
  if (SUCCEEDED(hr)) {
    BYTE* dst = NULL;
    hr = buf->lpVtbl->Lock(buf, &dst, NULL, NULL);
    if (SUCCEEDED(hr)) {
      /* 逐行拷贝：GPU 的 RowPitch 通常大于 stride（对齐填充），不能整块 memcpy。
         DXGI Desktop Duplication 的暂存纹理是 top-down（第 0 行在顶部），
         而 Media Foundation 的 RGB32 输入约定是 bottom-up（内存首行=图像底行），
         直接 top→top 拷贝会录出上下颠倒的画面。这里把源第 y 行写到目的第
         (encH-1-y) 行，做垂直翻转，画面正立。 */
      for (UINT y = 0; y < encH; y++) {
        memcpy(dst + (size_t)(encH - 1 - y) * stride,
               (const BYTE*)map.pData + (size_t)y * map.RowPitch,
               stride);
      }
      buf->lpVtbl->Unlock(buf);

      if (SUCCEEDED(hr)) hr = buf->lpVtbl->SetCurrentLength(buf, need);
      if (SUCCEEDED(hr)) {
        IMFSample* sample = NULL;
        hr = MFCreateSample(&sample);
        if (SUCCEEDED(hr)) {
          hr = sample->lpVtbl->AddBuffer(sample, buf);
          if (SUCCEEDED(hr)) {
            sample->lpVtbl->SetSampleTime(sample, t);
            sample->lpVtbl->SetSampleDuration(sample, dur);
            hr = writer->lpVtbl->WriteSample(writer, stream, sample);
          }
          sample->lpVtbl->Release(sample);
        }
      }
    }
    buf->lpVtbl->Release(buf);
  }
  d->ctx->lpVtbl->Unmap(d->ctx, (ID3D11Resource*)d->staging, 0);
  return hr;
}

/* 文件大小（收尾后报给主进程） */
static LONGLONG fileSize(const WCHAR* path) {
  HANDLE f = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                         NULL, OPEN_EXISTING, 0, NULL);
  if (f == INVALID_HANDLE_VALUE) return 0;
  LARGE_INTEGER sz;
  ZeroMemory(&sz, sizeof(sz));
  BOOL ok = GetFileSizeEx(f, &sz);
  CloseHandle(f);
  return ok ? sz.QuadPart : 0;
}

/* ---------------- 可暂停时钟 ----------------
 * 录制时间（100ns）= QPC 原始时间 - 累计暂停时长 - 当前这段已暂停时长。
 * 用它驱动 nextDue；时间戳本身另按"已写帧数 × 帧间隔"算 —— 两条线都排除
 * 暂停，所以暂停前后严格接得上，成片里没有空档也没有时间跳变。
 * ---------------------------------------------- */
typedef struct {
  LARGE_INTEGER freq;
  LARGE_INTEGER t0;
  LONGLONG pausedNs;      /* 之前几段暂停的累计时长 */
  LONGLONG pauseStartNs;  /* 本段暂停的起点（原始时间） */
  int paused;
} CapClock;

static LONGLONG clockRawNs(const CapClock* c) {
  LARGE_INTEGER n;
  QueryPerformanceCounter(&n);
  double d = (double)(n.QuadPart - c->t0.QuadPart);
  return (LONGLONG)(d * 10000000.0 / (double)c->freq.QuadPart);
}

static LONGLONG clockRecNs(const CapClock* c) {
  LONGLONG raw = clockRawNs(c);
  LONGLONG sub = c->pausedNs + (c->paused ? (raw - c->pauseStartNs) : 0);
  LONGLONG v = raw - sub;
  return v < 0 ? 0 : v;
}

static void usage(void) {
  printf("orb-cap.exe --out <file.mp4> [--fps 30] [--bitrate 6000000] [--display 0]\n");
  printf("  stdin commands: ping | pause | resume | stop | abort\n");
  fflush(stdout);
}

int main(void) {
  SetConsoleOutputCP(CP_UTF8);

  /* DPI 感知必须最先设：否则后面拿到的都是虚拟化坐标 */
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

  /* ---- 参数（宽字符：中文路径在 argv 里是 GBK，会被打坏） ---- */
  WCHAR outPath[MAX_PATH * 2];
  outPath[0] = 0;
  int fps = 30;
  int bitrate = 6000000;
  int display = 0;

  int argc = 0;
  LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (!argv) {
    emitErr(E_OUTOFMEMORY, "无法解析命令行");
    return 2;
  }
  for (int i = 1; i < argc; i++) {
    if (!wcscmp(argv[i], L"--out") && i + 1 < argc) {
      wcsncpy_s(outPath, _countof(outPath), argv[++i], _TRUNCATE);
    } else if (!wcscmp(argv[i], L"--fps") && i + 1 < argc) {
      fps = _wtoi(argv[++i]);
    } else if (!wcscmp(argv[i], L"--bitrate") && i + 1 < argc) {
      bitrate = _wtoi(argv[++i]);
    } else if (!wcscmp(argv[i], L"--display") && i + 1 < argc) {
      display = _wtoi(argv[++i]);
    } else if (!wcscmp(argv[i], L"--help") || !wcscmp(argv[i], L"-h")) {
      LocalFree(argv);
      usage();
      return 0;
    } else {
      char lossy[512];
      w2u8(argv[i], lossy, sizeof(lossy));
      emitErr(E_INVALIDARG, "未知参数: %s", lossy);
      LocalFree(argv);
      return 2;
    }
  }
  LocalFree(argv);

  char outU8[MAX_PATH * 4];
  w2u8(outPath, outU8, sizeof(outU8));

  if (outPath[0] == 0) {
    emitErr(E_INVALIDARG, "缺少 --out <绝对路径.mp4>");
    return 2;
  }
  if (fps < 1 || fps > 120) {
    emitErr(E_INVALIDARG, "不支持的 --fps %d（允许 1..120）", fps);
    return 2;
  }
  if (bitrate < 100000 || bitrate > 200000000) {
    emitErr(E_INVALIDARG, "不合理的 --bitrate %d", bitrate);
    return 2;
  }
  if (display != 0) {
    emitErr(E_INVALIDARG, "v1 只支持 --display 0（收到 %d）", display);
    return 2;
  }

  /* ---- COM / MF ---- */
  int coInited = 0, mfInited = 0;
  Dup dup;
  ZeroMemory(&dup, sizeof(dup));
  IMFSinkWriter* writer = NULL;
  DWORD stream = 0;
  int exitCode = 1;
  int writerOpened = 0;     /* writer 建成功后才允许删文件，避免误删同路径的旧文件 */
  LONGLONG encoded = 0;     /* 已写入的帧数（暂停不增） */
  int sizeChanged = 0;
  CapClock clock;
  ZeroMemory(&clock, sizeof(clock));

  HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
  if (FAILED(hr)) {
    emitErr((long)hr, "CoInitializeEx 失败");
    return 3;
  }
  coInited = 1;

  hr = MFStartup(MF_VERSION, MFSTARTUP_FULL);
  if (FAILED(hr)) {
    emitErr((long)hr, "MFStartup 失败");
    goto cleanup;
  }
  mfInited = 1;

  hr = dupCreate(&dup, display);
  if (FAILED(hr)) {
    emitErr((long)hr, "桌面复制初始化失败（%ux%u）", dup.w, dup.h);
    goto cleanup;
  }

  /* 奇数边长会让 H.264 编码器拒绝：裁到偶数（丢的是最后一列/行，肉眼不可见）。
     正常显示器不会走到这里，属于"别为了一个像素整段失败"的兜底。 */
  UINT encW = dup.w & ~1u;
  UINT encH = dup.h & ~1u;
  if (encW < 16 || encH < 16) {
    emitErr(E_FAIL, "桌面尺寸过小，无法编码：%ux%u", dup.w, dup.h);
    goto cleanup;
  }

  hr = writerCreate(outPath, encW, encH, fps, bitrate, &writer, &stream);
  if (FAILED(hr)) {
    emitErr((long)hr, "创建 MP4 编码器失败（输出 %s）", outU8);
    goto cleanup;
  }
  writerOpened = 1;

  /* writer 已 BeginWriting —— 从这一刻起主进程可以计时了 */
  QueryPerformanceFrequency(&clock.freq);
  QueryPerformanceCounter(&clock.t0);
  clock.paused = 0;
  clock.pausedNs = 0;
  clock.pauseStartNs = 0;

  emit("ready %u %u %d", encW, encH, fps);

  InitializeCriticalSection(&g_qLock);
  HANDLE reader = CreateThread(NULL, 0, stdinReader, NULL, 0, NULL);

  const LONGLONG dur = (LONGLONG)(10000000LL / fps);   /* 100ns/帧（30fps → 333333） */
  int haveFrame = 0;
  int stopMode = 0;        /* 0=继续 1=stop 2=abort */
  LONGLONG nextLogAt = fps; /* 每 fps 帧打一行 frame，约等于每秒一行 */

  for (;;) {
    /* ---- 1) 命令（非阻塞） ---- */
    for (;;) {
      CapCmd cmd = popCmd();
      if (cmd == CMD_NONE) break;
      if (cmd == CMD_PING) {
        emit("ok");
      } else if (cmd == CMD_PAUSE) {
        if (!clock.paused) {
          clock.paused = 1;
          clock.pauseStartNs = clockRawNs(&clock);
        }
        emit("paused");
      } else if (cmd == CMD_RESUME) {
        if (clock.paused) {
          clock.pausedNs += clockRawNs(&clock) - clock.pauseStartNs;
          clock.paused = 0;
        }
        emit("resumed");
      } else if (cmd == CMD_STOP) {
        stopMode = 1;
        break;
      } else if (cmd == CMD_ABORT) {
        stopMode = 2;
        break;
      } else {
        /* 未知命令：只写 stderr，不占用 stdout 的 err 通道。
           因为 err 的语义是"致命错误，随后非 0 退出"（主进程据此回退 VP9），
           而一条打错的命令不该把一段正在进行的录制判死 —— 但也不能静默，
           所以走 stderr（主进程照样能收进日志）。 */
        fprintf(stderr, "orb-cap: 未知命令（已忽略）\n");
        fflush(stderr);
      }
    }
    if (stopMode) break;

    /* ---- 2) 暂停：继续取帧丢弃，保持 duplication 健康，但不写样本 ---- */
    if (clock.paused) {
      DXGI_OUTDUPL_FRAME_INFO fi;
      IDXGIResource* res = NULL;
      ZeroMemory(&fi, sizeof(fi));
      HRESULT har = dup.dupl->lpVtbl->AcquireNextFrame(dup.dupl, CAP_ACQ_MAX_MS, &fi, &res);
      if (har == S_OK) {
        if (res) res->lpVtbl->Release(res);
        dup.dupl->lpVtbl->ReleaseFrame(dup.dupl);
      } else if (har == DXGI_ERROR_ACCESS_LOST) {
        int changed = 0;
        HRESULT rhr = dupRebuild(&dup, &changed);
        if (FAILED(rhr)) {
          emitErr((long)rhr, "切换分辨率后重建桌面复制连续失败");
          exitCode = 4;
          goto cleanup;
        }
        haveFrame = 0;
        if (changed) {
          /* 尺寸变了：当前文件的帧尺寸已经对不上，收尾这一段让主进程新起一段 */
          sizeChanged = 1;
          encW = dup.w & ~1u;
          encH = dup.h & ~1u;
          stopMode = 1;
          break;
        }
      } else if (FAILED(har) && har != DXGI_ERROR_WAIT_TIMEOUT) {
        emitErr((long)har, "暂停态取帧失败");
        exitCode = 4;
        goto cleanup;
      }
      continue;
    }

    /* ---- 3) 等到「有新帧」或「到点」，谁先到都回来 ---- */
    LONGLONG recNs = clockRecNs(&clock);
    LONGLONG dueNs = encoded * dur;
    DWORD waitMs;
    if (!haveFrame) {
      waitMs = 30;                       /* 首帧还没有：多等一点，别空转 */
    } else if (dueNs <= recNs) {
      waitMs = 1;                        /* 已经该写了：稍等一下新帧，没有就补重复帧 */
    } else {
      LONGLONG ms = (dueNs - recNs) / 10000;
      if (ms < 1) ms = 1;
      if (ms > CAP_ACQ_MAX_MS) ms = CAP_ACQ_MAX_MS;
      waitMs = (DWORD)ms;
    }

    DXGI_OUTDUPL_FRAME_INFO fi;
    IDXGIResource* res = NULL;
    ZeroMemory(&fi, sizeof(fi));
    HRESULT har = dup.dupl->lpVtbl->AcquireNextFrame(dup.dupl, waitMs, &fi, &res);
    if (har == S_OK) {
      ID3D11Texture2D* tex = NULL;
      if (SUCCEEDED(res->lpVtbl->QueryInterface(res, &IID_ID3D11Texture2D, (void**)&tex))) {
        dup.ctx->lpVtbl->CopyResource(dup.ctx, (ID3D11Resource*)dup.staging, (ID3D11Resource*)tex);
        haveFrame = 1;
        tex->lpVtbl->Release(tex);
      }
      dup.dupl->lpVtbl->ReleaseFrame(dup.dupl);
      res->lpVtbl->Release(res);
    } else if (har == DXGI_ERROR_ACCESS_LOST) {
      int changed = 0;
      HRESULT rhr = dupRebuild(&dup, &changed);
      if (FAILED(rhr)) {
        emitErr((long)rhr, "重建桌面复制连续失败");
        exitCode = 4;
        goto cleanup;
      }
      haveFrame = 0;
      if (changed) {
        sizeChanged = 1;
        encW = dup.w & ~1u;
        encH = dup.h & ~1u;
        stopMode = 1;
        break;
      }
      continue;
    } else if (har != DXGI_ERROR_WAIT_TIMEOUT) {
      /* 桌面静止时会 WAIT_TIMEOUT，这是常态，不算错 */
      emitErr((long)har, "取帧失败");
      exitCode = 4;
      goto cleanup;
    }

    /* ---- 4) 到点就写：没有新帧就重复上一帧（CFR 的关键） ---- */
    while (haveFrame && !clock.paused && clockRecNs(&clock) >= encoded * dur) {
      LONGLONG t = encoded * dur;
      hr = writeFrame(writer, stream, &dup, encW, encH, t, dur);
      if (FAILED(hr)) {
        emitErr((long)hr, "写入帧失败（第 %lld 帧）", encoded);
        exitCode = 5;
        goto cleanup;
      }
      encoded++;
      if (encoded >= nextLogAt) {
        emit("frame %lld", encoded);
        nextLogAt += fps;   /* 每秒最多一行 */
      }
    }
  }

  /* ---- 5) 收尾 ---- */
  if (stopMode == 2) {
    /* abort：释放（关文件句柄）→ 删半成品 → 报 aborted。不 Finalize。 */
    if (writer) { writer->lpVtbl->Release(writer); writer = NULL; }
    DeleteFileW(outPath);
    emit("aborted");
    exitCode = 0;
    goto cleanup;
  }

  /* 一帧都没写进去：这种 MP4 播放器打不开，直接报错让主进程回退 VP9，
     而不是交一个"看着有文件、打开是坏的"的成片。 */
  if (encoded <= 0) {
    emitErr(E_FAIL, "本次没有采集到任何帧（%s）", outU8);
    exitCode = 7;
    goto cleanup;
  }

  hr = writer->lpVtbl->Finalize(writer);
  if (FAILED(hr)) {
    emitErr((long)hr, "MP4 收尾失败（%s）", outU8);
    exitCode = 6;
    goto cleanup;
  }
  writer->lpVtbl->Release(writer);
  writer = NULL;

  {
    LONGLONG bytes = fileSize(outPath);
    LONGLONG elapsedMs = (LONGLONG)((encoded * dur) / 10000);
    if (bytes <= 0) {
      /* 文件没写出来：协议上仍算失败，让主进程回退 */
      emitErr(E_FAIL, "MP4 文件为空（%s）", outU8);
      exitCode = 6;
      goto cleanup;
    }
    if (sizeChanged) {
      /* 尺寸变了：末尾追加新尺寸，主进程据此新起一段 */
      emit("done %lld %lld %u %u", bytes, elapsedMs, encW, encH);
    } else {
      emit("done %lld %lld", bytes, elapsedMs);
    }
  }
  exitCode = 0;

cleanup:
  if (writer) { writer->lpVtbl->Release(writer); writer = NULL; }
  /* 异常退出（含 abort 之外的所有非 0 退出）：把半成品删掉，
     别在 recordings 里留一个没人认领的坏文件。 */
  if (exitCode != 0 && writerOpened) DeleteFileW(outPath);
  dupDestroy(&dup);
  if (mfInited) MFShutdown();
  if (coInited) CoUninitialize();
  return exitCode;
}
