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
 *               [--rect <x> <y> <w> <h>] [--audio none|system|mic|mix]
 *
 *   --audio 采集音频并压成第二条 AAC 流（默认 none，与旧版行为完全一致）：
 *     system = 系统声（渲染端点环回）、mic = 麦克风、mix = 两路混音 + 限幅。
 *   任一路打不开都只降级不失败 —— 视频必须照录，宁可无声也不要整段录不出来。
 *
 *   --rect 只录屏幕的某一块（区域录制）。坐标是**物理像素**，原点在显示器左上角，
 *   与 DXGI 复制缓冲区的坐标系一致（DPI 感知已开到 PER_MONITOR_AWARE_V2）。
 *   越界自动裁到屏幕内，宽高各向下取偶（H.264 要求偶数边长）。不给就是整屏。
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
 *   audio on <rate> <ch> <src>   音频已开（src = system / mic / system+mic）
 *   audio off <reason>           音频没开成，视频照录（reason 不含空格）
 *   frame <n> <sysLv> <micLv>    已写入帧数 + 两路电平 0..100（每秒最多一行）
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
 *     音频同理按"已写样本数 × 10^7 / 48000"算，并强制追上 encoded/audioRate 的目标值
 *     —— 两条轨各自从同一条逻辑时钟派生，所以暂停、跳帧都不会音画错位。
 *  3) **ACCESS_LOST**（切分辨率 / 锁屏 / 全屏切换）：整条 duplication 作废，重建；
 *     连续失败 5 次才报 err。尺寸变了就收尾当前文件、done 里带新尺寸、以 0 退出
 *     （v1 不要求跨段无缝，主进程新起一个文件）。
 *  4) **每帧新建 MF 缓冲**：MF 会异步持有 sample，复用同一块内存会写出花屏。
 *  5) **DPI**：必须 PER_MONITOR_AWARE_V2，否则窗口坐标是虚拟化的、和复制缓冲区
 *     不是一个坐标系（Stage 0 探针就是被这个坑过）。
 *  6) **中文路径**：argv 是 GBK 转来的，会打坏路径 —— 用 CommandLineToArgvW
 *     直接取宽字符命令行。
 *  7) 失败一律 err + 非 0 退出，绝不静默（主进程要靠它回退）。
 *  8) **音频**：系统声只能靠 WASAPI 的渲染端点环回（DXGI 复制只有像素，没有声音）。
 *     采样率钉 48k（AAC 只吃 44.1k/48k，48k 是 Windows 混音引擎原生档位），
 *     首选 AUTOCONVERTPCM 让系统转，失败才退回手工转换。采集在独立线程里跑，
 *     主线程只做非阻塞取数 —— 绝不能因为等音频设备而掉帧。
 *
 * v1 边界：只录主显示器（--display 0）、不分段续录、不分片。
 *   --rect 是"附加面"，不影响原来的整屏路径：不带这个参数时行为与 v1 完全一致。
 *   --audio 同样是附加面：不给就是纯视频，输出流数量与旧版一致。
 * 编译：powershell -File orb/native/build-cap.ps1
 * --------------------------------------------------------------- */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
/* 1_6 只是为了让 IDXGIOutput5::DuplicateOutput1 有个正式类型可用
   （HDR 桌面时先试着要一份 SDR 的 BGRA8）。GUID 仍然是手写的，见 dupCreate。 */
#include <dxgi1_6.h>
#include <math.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mferror.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
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
#pragma comment(lib, "uuid.lib")

#define CAP_CMDQ 64          /* 命令队列长度（命令很少，够用） */
#define CAP_LINE 256         /* 单行命令长度上限 */
#define CAP_ACQ_MAX_MS 16    /* 单次等待新帧的上限（≈ 一帧 @60fps） */
#define CAP_REBUILD_TRIES 5  /* ACCESS_LOST 连续重建次数上限 */

/* 音频固定参数：48k / 立体声 / 16 bit，一帧 4 字节。
   选 48k 是因为 AAC 只接受 44.1k 与 48k，而 48k 是 Windows 混音引擎的原生档位
   （绝大多数设备混音格式就是 48k float32 立体声，转换量最小）。 */
#define AUD_RATE 48000
#define AUD_CH 2
#define AUD_FRAME_BYTES 4              /* s16 × 2 */
#define AUD_RING 48000                 /* 环形缓冲 1 秒 */
#define AUD_POLL_MS 5                  /* 采集线程轮询间隔 */
#define AUD_CHUNK 1024                 /* 单个 MF 样本最多 1024 帧（栈缓冲上限） */
#define AUD_STARVE_NS 1250000          /* 缺口超过 125ms 才补静音（吸收抖动） */

/* --audio 档位 */
enum { AUDIO_NONE = 0, AUDIO_SYSTEM = 1, AUDIO_MIC = 2, AUDIO_MIX = 3 };


/* WASAPI 的 CLSID/IID 自己写死：SDK 里这几个符号只有声明，靠 INITGUID 或
   某个 lib 提供，在不同版本的 Windows Kits 上行为不一致（实测 10.0.28000 就
   是 LNK2019）。它们是固定的公开 GUID，直接定义最省事，也不受 SDK 差异影响。 */
static const GUID ORB_CLSID_MMDeviceEnumerator =
  { 0xBCDE0395, 0xE52F, 0x467C, { 0x8E, 0x3D, 0xC4, 0x57, 0x92, 0x91, 0x69, 0x2E } };
static const GUID ORB_IID_IMMDeviceEnumerator =
  { 0xA95664D2, 0x9614, 0x4F35, { 0xA7, 0x46, 0xDE, 0x8D, 0xB6, 0x36, 0x17, 0xE6 } };
static const GUID ORB_IID_IAudioClient =
  { 0x1CB9AD4C, 0xDBFA, 0x4C32, { 0xB1, 0x78, 0xC2, 0xF5, 0x68, 0xA7, 0x03, 0xB2 } };
static const GUID ORB_IID_IAudioCaptureClient =
  { 0xC8ADBD64, 0xE71E, 0x48A0, { 0xA4, 0xDE, 0x18, 0x5C, 0x39, 0x5C, 0xD3, 0x17 } };

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
/* ---------------- 桌面格式 / 屏幕旋转 ----------------
 * 两个"以前没管、但真机上一录就崩"的东西：
 *   ① 竖屏 / 旋转屏：DXGI 复制出来的永远是**旋转前**的桌面位图。屏幕转 90°
 *      时 ModeDesc 还是 1920x1080，但用户看到的是 1080x1920。不按
 *      DXGI_OUTDUPL_DESC.Rotation 自己转，录出来就是横躺的。
 *   ② HDR 桌面：ModeDesc.Format 是 R10G10B10A2 或 R16G16B16A16_FLOAT，
 *      暂存纹理写死 B8G8R8A8 的话 CopyResource 直接 E_INVALIDARG ——
 *      表现就是"录不出来"，连错都看不清。必须同格式建纹理再转成 BGRA8。
 * ---------------------------------------------- */

/* 旋转后的输出尺寸（用户实际看到的画面尺寸）。 */
static void rotOutSize(DXGI_MODE_ROTATION rot, UINT srcW, UINT srcH, UINT* outW, UINT* outH) {
  if (rot == DXGI_MODE_ROTATION_ROTATE90 || rot == DXGI_MODE_ROTATION_ROTATE270) {
    *outW = srcH;
    *outH = srcW;
  } else {
    *outW = srcW;
    *outH = srcH;
  }
}

/* 旋转后坐标 (X,Y) → 源纹理坐标。ROTATE90 是顺时针 90°（微软定义），
 * 所以输出第 X 列来自源第 X 行。四个分支都验算过边界：X∈[0,outW)、Y∈[0,outH)。 */
static void rotMap(DXGI_MODE_ROTATION rot, UINT srcW, UINT srcH, UINT X, UINT Y,
                   UINT* sx, UINT* sy) {
  switch (rot) {
    case DXGI_MODE_ROTATION_ROTATE90:
      *sx = Y;
      *sy = (srcH - 1) - X;
      break;
    case DXGI_MODE_ROTATION_ROTATE180:
      *sx = (srcW - 1) - X;
      *sy = (srcH - 1) - Y;
      break;
    case DXGI_MODE_ROTATION_ROTATE270:
      *sx = (srcW - 1) - Y;
      *sy = X;
      break;
    default:                     /* IDENTITY / UNSPECIFIED */
      *sx = X;
      *sy = Y;
      break;
  }
}

/* HDR 用的两张 1024 项查表。逐像素 powf 在 1080p@30 上是 6 千万次幂运算，
 * 单核直接跪；查表把每像素压到"一次乘法 + 一次数组访问"。 */
static BYTE g_pqLut[1024];      /* PQ(HDR10 10bit) → sRGB8 */
static BYTE g_rhLut[1024];      /* scRGB 线性 → Reinhard → sRGB8 */
static int g_lutReady = 0;

static BYTE srgbEncode8(float v) {
  if (!(v > 0.0f)) return 0;    /* 同时挡住 NaN */
  if (v >= 1.0f) return 255;
  float s = (v <= 0.0031308f) ? (12.92f * v) : (1.055f * powf(v, 1.0f / 2.4f) - 0.055f);
  int i = (int)(s * 255.0f + 0.5f);
  return (BYTE)(i < 0 ? 0 : (i > 255 ? 255 : i));
}

/* HDR → SDR 的高光滚降。输入 v 以「203 nit」= 1。
 *
 * 为什么不是简单归一化：8bit 输出里 255 只有一个值，如果让 SDR 白就顶到 255，
 * 上面所有 HDR 高光全被裁掉、整片死白。所以 SDR 白停在 0.92（sRGB≈246），
 * 0.7 之前完全直通（暗部和中调不受影响，桌面 UI 不会发灰），
 * 0.7 之后用指数软肩渐近到 0.92 —— 单调递增、有界、C1 连续。
 * 代价是 HDR 的高光层次被压薄，这是任何 HDR→SDR 都必须付的。 */
static float hdrRolloff(float v) {
  const float knee = 0.7f;
  const float a = 0.92f;
  if (!(v > 0.0f)) return 0.0f;
  if (v <= knee) return v;
  return knee + (a - knee) * (1.0f - expf(-(v - knee) / (a - knee)));
}

static void lutBuild(void) {
  if (g_lutReady) return;
  /* ST.2084 EOTF 常数 */
  const float m1 = 2610.0f / 16384.0f;
  const float m2 = 2523.0f / 4096.0f * 128.0f;
  const float c1 = 3424.0f / 4096.0f;
  const float c2 = 2413.0f / 4096.0f * 32.0f;
  const float c3 = 2392.0f / 4096.0f * 32.0f;
  for (int i = 0; i < 1024; i++) {
    float e = (float)i / 1023.0f;
    float p = powf(e, 1.0f / m2);
    float den = c2 - c3 * p;
    float lin = 0.0f;
    if (den > 1e-6f && p > c1) lin = powf((p - c1) / den, 1.0f / m1);
    /* 10000 nit 线性值 → 以 203 nit（SDR 白）为 1，再做高光滚降（见 hdrRolloff） */
    float v = lin / 0.0203f;
    g_pqLut[i] = srgbEncode8(hdrRolloff(v));

    /* scRGB：索引是 t = v/(1+v) 的等分，所以这里要反解回 v 再算同一套滚降。
       pxToBGRA 里做的是正变换（lin → t → 索引），两边必须一致。 */
    float v2 = (e >= 0.9995f) ? 1e6f : (e / (1.0f - e));
    g_rhLut[i] = srgbEncode8(hdrRolloff(v2));
  }
  g_lutReady = 1;
}

/* IEEE 754 半精度 → float。RGBA16F 桌面的原始数据就是它。 */
static float halfToFloat(unsigned short h) {
  unsigned int s = (h >> 15) & 1u;
  unsigned int e = (h >> 10) & 0x1Fu;
  unsigned int m = h & 0x3FFu;
  float v;
  if (e == 0) {
    if (!m) return s ? -0.0f : 0.0f;
    v = ldexpf((float)m, -24);          /* 次正规数：m × 2^-24 */
    return s ? -v : v;
  }
  if (e == 31) return 0.0f;             /* Inf/NaN 一律压成 0，别让花屏像素传染 */
  v = ldexpf(1.0f + (float)m / 1024.0f, (int)e - 15);
  return s ? -v : v;
}

/* 这个桌面格式我们认不认。不认识的直接报错，别录出一片黑还以为是"画面本来就黑"。 */
static int fmtSupported(DXGI_FORMAT f) {
  return f == DXGI_FORMAT_B8G8R8A8_UNORM || f == DXGI_FORMAT_B8G8R8A8_UNORM_SRGB ||
         f == DXGI_FORMAT_R8G8B8A8_UNORM || f == DXGI_FORMAT_R8G8B8A8_UNORM_SRGB ||
         f == DXGI_FORMAT_R10G10B10A2_UNORM || f == DXGI_FORMAT_R16G16B16A16_FLOAT;
}

/* 一个像素的源字节数（逐像素路径算偏移用）。 */
static UINT fmtBytesPerPx(DXGI_FORMAT f) {
  if (f == DXGI_FORMAT_R10G10B10A2_UNORM) return 4;
  if (f == DXGI_FORMAT_R16G16B16A16_FLOAT) return 8;
  return 4;
}

/* 把源纹理的一个像素转成 BGRA8。 */
static void pxToBGRA(const BYTE* p, DXGI_FORMAT fmt, BYTE* out) {
  switch (fmt) {
    case DXGI_FORMAT_B8G8R8A8_UNORM:
    case DXGI_FORMAT_B8G8R8A8_UNORM_SRGB:
      out[0] = p[0]; out[1] = p[1]; out[2] = p[2]; out[3] = 255;
      break;
    case DXGI_FORMAT_R8G8B8A8_UNORM:
    case DXGI_FORMAT_R8G8B8A8_UNORM_SRGB:
      out[0] = p[2]; out[1] = p[1]; out[2] = p[0]; out[3] = 255;
      break;
    case DXGI_FORMAT_R10G10B10A2_UNORM: {
      const unsigned int v = *(const unsigned int*)p;
      const unsigned int r = v & 0x3FFu, g = (v >> 10) & 0x3FFu, b = (v >> 20) & 0x3FFu;
      out[0] = g_pqLut[b]; out[1] = g_pqLut[g]; out[2] = g_pqLut[r]; out[3] = 255;
      break;
    }
    case DXGI_FORMAT_R16G16B16A16_FLOAT: {
      const unsigned short* h = (const unsigned short*)p;
      /* scRGB 的 1.0 = 80 nit，而我们以 203 nit 为白（与 PQ 那条同一个锚点），
         所以先乘 80/203，再走 t = lin/(1+lin) 的索引，与 lutBuild 的 scRGB 段对齐。 */
      const float K = 0.394f;
      const float r = halfToFloat(h[0]) * K;
      const float g = halfToFloat(h[1]) * K;
      const float b = halfToFloat(h[2]) * K;
      int ir = (int)((r / (1.0f + r)) * 1023.0f);
      int ig = (int)((g / (1.0f + g)) * 1023.0f);
      int ib = (int)((b / (1.0f + b)) * 1023.0f);
      if (ir < 0) ir = 0;
      if (ir > 1023) ir = 1023;
      if (ig < 0) ig = 0;
      if (ig > 1023) ig = 1023;
      if (ib < 0) ib = 0;
      if (ib > 1023) ib = 1023;
      out[0] = g_rhLut[ib]; out[1] = g_rhLut[ig]; out[2] = g_rhLut[ir]; out[3] = 255;
      break;
    }
    default:
      out[0] = out[1] = out[2] = 0; out[3] = 255;
      break;
  }
}

/* 把「旋转 + 裁剪 + 格式转换 + 垂直翻转」合成一次遍历。
 *
 * 为什么四件事挤在一个循环里：源纹理是 GPU 的 top-down，MF 的 RGB32 是
 * bottom-up，本来就要逐行搬；旋转和裁剪只是换一下"从哪一行哪一列取"，
 * 多写一遍循环只会多一处忘记改的地方。
 *
 * cropX/cropY 是**旋转后坐标系**里的起点（和 --rect 的语义一致）。
 */
static void blitFrame(BYTE* dst, DWORD dstStride, const BYTE* src, DWORD srcPitch,
                      UINT srcW, UINT srcH, DXGI_FORMAT fmt, DXGI_MODE_ROTATION rot,
                      UINT cropX, UINT cropY, UINT w, UINT h) {
  lutBuild();
  const int plain =
      (rot == DXGI_MODE_ROTATION_IDENTITY || rot == DXGI_MODE_ROTATION_UNSPECIFIED) &&
      (fmt == DXGI_FORMAT_B8G8R8A8_UNORM || fmt == DXGI_FORMAT_B8G8R8A8_UNORM_SRGB);
  if (plain) {
    /* 绝大多数机器走这里：纯 memcpy，和改之前一模一样 */
    const size_t xoff = (size_t)cropX * 4;
    for (UINT y = 0; y < h; y++) {
      memcpy(dst + (size_t)(h - 1 - y) * dstStride,
             src + (size_t)(cropY + y) * srcPitch + xoff,
             (size_t)w * 4);
    }
    return;
  }
  const UINT bpp = fmtBytesPerPx(fmt);
  for (UINT y = 0; y < h; y++) {
    BYTE* drow = dst + (size_t)(h - 1 - y) * dstStride;
    for (UINT x = 0; x < w; x++) {
      UINT sx, sy;
      rotMap(rot, srcW, srcH, cropX + x, cropY + y, &sx, &sy);
      pxToBGRA(src + (size_t)sy * srcPitch + (size_t)sx * bpp, fmt, drow + (size_t)x * 4);
    }
  }
}

typedef struct {
  ID3D11Device* dev;
  ID3D11DeviceContext* ctx;
  IDXGIAdapter* adapter;
  IDXGIOutput* output;
  IDXGIOutput1* output1;
  IDXGIOutputDuplication* dupl;
  ID3D11Texture2D* staging;   /* GPU → CPU 的暂存纹理（D3D11_USAGE_STAGING） */
  UINT w;                     /* 源纹理尺寸（旋转前，也是 ModeDesc 的尺寸） */
  UINT h;
  DXGI_FORMAT srcFmt;         /* 暂存纹理的真实格式：HDR 桌面不是 BGRA8 */
  DXGI_MODE_ROTATION rot;     /* 屏幕旋转；竖屏是 ROTATE90 / ROTATE270 */
  UINT outW;                  /* 旋转之后的输出尺寸 = 用户实际看到的画面尺寸 */
  UINT outH;
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
  d->outW = 0;
  d->outH = 0;
  d->srcFmt = DXGI_FORMAT_B8G8R8A8_UNORM;
  d->rot = DXGI_MODE_ROTATION_IDENTITY;
}

/* IDXGIOutput5 的 IID（{80A07424-AB52-42EB-833C-0C42ACBC2C34}）。
 * 自己写死而不是用 IID_IDXGIOutput5：和文件里其它 COM GUID 同一个理由 ——
 * SDK 版本差异下只有声明没有定义，链接期 LNK2019。写错了也只是
 * QueryInterface 失败后退回 DuplicateOutput，功能不丢。 */
static const GUID ORB_IID_IDXGIOutput5 =
  { 0x80A07424, 0xAB52, 0x42EB, { 0x83, 0x3C, 0x0C, 0x42, 0xAC, 0xBC, 0x2C, 0x34 } };

static HRESULT dupCreate(Dup* d, int displayIndex) {
  ZeroMemory(d, sizeof(*d));
  d->srcFmt = DXGI_FORMAT_B8G8R8A8_UNORM;
  d->rot = DXGI_MODE_ROTATION_IDENTITY;
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
  /* 先试着让驱动直接给一份 SDR(BGRA8)：HDR 桌面下能成的话，后面完全不用转换。
     多数驱动会拒绝（E_INVALIDARG），那就退回默认格式，自己转。 */
  if (SUCCEEDED(hr)) {
    IDXGIOutput5* out5 = NULL;
    if (SUCCEEDED(d->output1->lpVtbl->QueryInterface(d->output1, &ORB_IID_IDXGIOutput5, (void**)&out5)) && out5) {
      DXGI_FORMAT want[1];
      want[0] = DXGI_FORMAT_B8G8R8A8_UNORM;
      out5->lpVtbl->DuplicateOutput1(out5, (IUnknown*)d->dev, 0, 1, want, &d->dupl);
      out5->lpVtbl->Release(out5);
      if (d->dupl) {
        fprintf(stderr, "orb-cap: HDR 桌面已让驱动直接给 SDR(BGRA8)，无需转换\n");
        fflush(stderr);
      }
    }
    if (!d->dupl) {
      hr = d->output1->lpVtbl->DuplicateOutput(d->output1, (IUnknown*)d->dev, &d->dupl);
    } else {
      hr = S_OK;
    }
  }
  if (SUCCEEDED(hr) && d->dupl) {
    DXGI_OUTDUPL_DESC dd;
    ZeroMemory(&dd, sizeof(dd));
    d->dupl->lpVtbl->GetDesc(d->dupl, &dd);
    d->w = dd.ModeDesc.Width;
    d->h = dd.ModeDesc.Height;
    d->srcFmt = dd.ModeDesc.Format;
    d->rot = dd.Rotation;
    rotOutSize(d->rot, d->w, d->h, &d->outW, &d->outH);
    if (!fmtSupported(d->srcFmt)) {
      /* 认不出的桌面格式：宁可明确失败，也不要录出一片黑 */
      hr = DXGI_ERROR_UNSUPPORTED;
    }
  }
  if (SUCCEEDED(hr)) {
    D3D11_TEXTURE2D_DESC td;
    ZeroMemory(&td, sizeof(td));
    td.Width = d->w;
    td.Height = d->h;
    td.MipLevels = 1;
    td.ArraySize = 1;
    /* **必须和桌面同格式**：不同格式的 CopyResource 直接被 D3D11 拒绝
       （HDR 桌面 + 写死 BGRA8 = "录不出画面"的根因）。转成 BGRA8 在 blitFrame 里做。 */
    td.Format = d->srcFmt;
    td.SampleDesc.Count = 1;
    td.Usage = D3D11_USAGE_STAGING;
    td.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    hr = d->dev->lpVtbl->CreateTexture2D(d->dev, &td, NULL, &d->staging);
  }
  if (FAILED(hr)) dupDestroy(d);
  return hr;
}

/* 按实际拿到的 surface 格式重建暂存纹理。
   GetDesc 报的格式和真实 surface 偶尔不一致（多显卡 / 驱动混合输出时见过），
   不一致时 CopyResource 会失败 —— 那时不该让整段录制死掉，换一块同格式的
   暂存纹理继续。 */
static HRESULT dupRestage(Dup* d, DXGI_FORMAT fmt) {
  D3D11_TEXTURE2D_DESC td;
  ZeroMemory(&td, sizeof(td));
  td.Width = d->w;
  td.Height = d->h;
  td.MipLevels = 1;
  td.ArraySize = 1;
  td.Format = fmt;
  td.SampleDesc.Count = 1;
  td.Usage = D3D11_USAGE_STAGING;
  td.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  ID3D11Texture2D* t = NULL;
  HRESULT hr = d->dev->lpVtbl->CreateTexture2D(d->dev, &td, NULL, &t);
  if (FAILED(hr)) return hr;
  if (d->staging) d->staging->lpVtbl->Release(d->staging);
  d->staging = t;
  d->srcFmt = fmt;
  fprintf(stderr, "orb-cap: 暂存纹理改用实际格式 %u\n", (unsigned)fmt);
  fflush(stderr);
  return S_OK;
}

/* 按当前复制尺寸算出「源起点 + 输出尺寸」（区域录制用）。
   整屏（hasRect=0）时 srcX/srcY = 0、输出 = 屏幕尺寸取偶，与 v1 行为一致。
   ACCESS_LOST 重建后屏幕尺寸可能变，所以 main 与两条 rebuild 分支都走这一处，
   不各写一份 —— 三份拷贝迟早会有一份忘了改。 */
static void calcEncRect(UINT dispW, UINT dispH, int hasRect,
                        int rectX, int rectY, int rectW, int rectH,
                        UINT* outSrcX, UINT* outSrcY, UINT* outW, UINT* outH) {
  UINT sx = 0, sy = 0;
  UINT w = dispW & ~1u, h = dispH & ~1u;
  if (hasRect) {
    int x = rectX, y = rectY, cw = rectW, ch = rectH;
    /* 夹到屏幕内；贴边过近时留 16px，否则裁完会小于编码器下限 */
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x > (int)dispW - 16) x = (int)dispW - 16;
    if (y > (int)dispH - 16) y = (int)dispH - 16;
    if (cw > (int)dispW - x) cw = (int)dispW - x;
    if (ch > (int)dispH - y) ch = (int)dispH - y;
    sx = (UINT)x & ~1u;          /* 原点也取偶：宽高各少一像素时不会读到缓冲区外 */
    sy = (UINT)y & ~1u;
    w = (UINT)cw & ~1u;
    h = (UINT)ch & ~1u;
    if (sx + w > dispW) w = (dispW - sx) & ~1u;
    if (sy + h > dispH) h = (dispH - sy) & ~1u;
  }
  *outSrcX = sx;
  *outSrcY = sy;
  *outW = w;
  *outH = h;
}

/* ACCESS_LOST：整包重建，最多 CAP_REBUILD_TRIES 次。
   成功返回 S_OK；changed 回填"分辨率变了"（调用方据此收尾当前文件）。 */static HRESULT dupRebuild(Dup* d, int* changed) {
  UINT oldW = d->outW, oldH = d->outH;
  DXGI_MODE_ROTATION oldRot = d->rot;
  HRESULT hr = E_FAIL;
  if (changed) *changed = 0;
  for (int i = 0; i < CAP_REBUILD_TRIES; i++) {
    dupDestroy(d);
    hr = dupCreate(d, 0);
    if (SUCCEEDED(hr)) {
      /* 比的是**输出**尺寸和旋转：屏幕从横屏转成竖屏时 w/h 没变，
         变的只有 rot 和 outW/outH —— 只比 w/h 会漏掉这一整类。 */
      if (changed && (d->outW != oldW || d->outH != oldH || d->rot != oldRot)) *changed = 1;
      return S_OK;
    }
    Sleep(120);   /* 锁屏/切换分辨率的中途会连续失败，等一下再试 */
  }
  return hr;
}

/* ---------------- SinkWriter ----------------
 * 输出 H.264 / MP4，输入 RGB32（BGRA，和暂存纹理同格式 → 拷贝就是纯 memcpy）。
 * 音频另开第二条流（AAC）。定义在文件后半段，这里先声明。
 * ---------------------------------------------- */
static HRESULT writerAddAudio(IMFSinkWriter* writer, DWORD* outStream);

static HRESULT writerCreate(const WCHAR* path, UINT w, UINT h, int fps, int bitrate,
                            int withAudio, IMFSinkWriter** outWriter,
                            DWORD* outStream, DWORD* outAudio) {
  *outWriter = NULL;
  *outStream = 0;
  if (outAudio) *outAudio = 0;

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
  /* 音频流必须在 BeginWriting 之前加：BeginWriting 之后流表就冻结了。
     加失败不算致命 —— 把 withAudio 收回，出纯视频片（与旧版行为一致）。 */
  if (SUCCEEDED(hr) && withAudio && outAudio) {
    if (FAILED(writerAddAudio(writer, outAudio))) {
      fprintf(stderr, "orb-cap: AAC 音频流创建失败，改为只录画面\n");
      fflush(stderr);
      *outAudio = 0;
    }
  }
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
   每帧新建 MF 缓冲，不复用：MF 会异步持有 sample，复用同一块内存会写出花屏。

   srcX / srcY 是**旋转后坐标系里的起点**（区域录制用，和 --rect 语义一致）。
   整屏录制时两者都是 0，路径与原实现完全一致 —— 只多了一次加法。

   cpu / cpuPitch 非空时改用这块 CPU 位图作源（GDI 兜底首帧用），不再 Map 纹理。
   那块位图是 GDI 按旋转后的屏幕抓的，所以对它不施加旋转。 */
static HRESULT writeFrame(IMFSinkWriter* writer, DWORD stream, Dup* d,
                          const BYTE* cpu, UINT cpuPitch,
                          UINT encW, UINT encH, UINT srcX, UINT srcY,
                          LONGLONG t, LONGLONG dur) {
  D3D11_MAPPED_SUBRESOURCE map;
  ZeroMemory(&map, sizeof(map));
  HRESULT hr = S_OK;
  if (cpu) {
    map.pData = (void*)cpu;
    map.RowPitch = cpuPitch;
  } else {
    hr = d->ctx->lpVtbl->Map(d->ctx, (ID3D11Resource*)d->staging, 0,
                             D3D11_MAP_READ, 0, &map);
    if (FAILED(hr)) return hr;
  }

  const DWORD stride = encW * 4;
  const DWORD need = stride * encH;
  IMFMediaBuffer* buf = NULL;
  hr = MFCreateMemoryBuffer(need, &buf);
  if (SUCCEEDED(hr)) {
    BYTE* dst = NULL;
    hr = buf->lpVtbl->Lock(buf, &dst, NULL, NULL);
    if (SUCCEEDED(hr)) {
      /* 拷贝不再是"逐行 memcpy"了：旋转屏要转、HDR 桌面要转格式、区域要裁、
         垂直要翻 —— 四件事都在 blitFrame 里一次遍历做完。
         不变的那条快速路径（BGRA8 + 不旋转）在里面仍然是纯 memcpy。 */
      const BYTE* src = (const BYTE*)map.pData;
      DWORD pitch = map.RowPitch;
      UINT sw = d->w, sh = d->h;
      DXGI_FORMAT fmt = d->srcFmt;
      DXGI_MODE_ROTATION rot = d->rot;
      if (cpu) {
        /* GDI 兜底位图是按**旋转后**的桌面坐标抓的（见 gdiGrab），
           已经是 BGRA8 + 正立，不需要再转一次。 */
        sw = d->outW;
        sh = d->outH;
        fmt = DXGI_FORMAT_B8G8R8A8_UNORM;
        rot = DXGI_MODE_ROTATION_IDENTITY;
      }
      blitFrame(dst, stride, src, pitch, sw, sh, fmt, rot, srcX, srcY, encW, encH);
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
  if (!cpu) d->ctx->lpVtbl->Unmap(d->ctx, (ID3D11Resource*)d->staging, 0);
  return hr;
}

/* GDI 抓一屏（BGRA、top-down，行距 = w*4）。
   为什么需要它：DXGI Desktop Duplication **只在桌面有变化时才给帧**，桌面完全
   静止（或锁屏后没人动）时 AcquireNextFrame 会一直 WAIT_TIMEOUT —— 旧版于是
   一帧都拿不到，直接报"没有采集到任何帧"把录制判死。用户录一个静止的文档页面
   是最常见的场景，不能被判死。所以首帧超过 500ms 还没来就用 GDI 兜一张，
   之后 CFR 会重复这一帧，等真有变化再切回纹理路径。
   biHeight 取负 = top-down，和 DXGI 纹理的行序一致，翻转逻辑不用改。 */
static int gdiGrab(UINT w, UINT h, BYTE* out) {
  if (!out || w == 0 || h == 0) return 0;
  HDC screen = GetDC(NULL);
  if (!screen) return 0;
  HDC mem = CreateCompatibleDC(screen);
  BITMAPINFO bi;
  ZeroMemory(&bi, sizeof(bi));
  bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bi.bmiHeader.biWidth = (LONG)w;
  bi.bmiHeader.biHeight = -(LONG)h;
  bi.bmiHeader.biPlanes = 1;
  bi.bmiHeader.biBitCount = 32;
  bi.bmiHeader.biCompression = BI_RGB;
  void* bits = NULL;
  HBITMAP bmp = CreateDIBSection(screen, &bi, DIB_RGB_COLORS, &bits, NULL, 0);
  int ok = 0;
  if (mem && bmp && bits) {
    HGDIOBJ old = SelectObject(mem, bmp);
    if (BitBlt(mem, 0, 0, (int)w, (int)h, screen, 0, 0, SRCCOPY | CAPTUREBLT)) {
      memcpy(out, bits, (size_t)w * h * 4);
      ok = 1;
    }
    SelectObject(mem, old);
  }
  if (bmp) DeleteObject(bmp);
  if (mem) DeleteDC(mem);
  ReleaseDC(NULL, screen);
  return ok;
}

/* ================= 音频采集（WASAPI） =================
 * 系统声**不可能**从 DXGI 拿到 —— 复制缓冲区里只有像素。要声音只能另开
 * WASAPI：系统声 = 默认渲染端点的环回采集（AUDCLNT_STREAMFLAGS_LOOPBACK），
 * 麦克风 = 默认捕获端点。两者是两条完全独立的会话，所以各配一个线程 + 一个
 * 环形缓冲，混音放在「取」的一侧做，任何一路卡住都不拖累另一路。
 *
 * 采样率统一钉 48k / 立体声 / s16。首选让 Windows 自己转
 * （AUTOCONVERTPCM|SRC_DEFAULT_QUALITY），成功了这一层就什么都不用做；
 * 失败才退回设备混音格式并手工转换（float32/int16/int32-in-32 + 声道矩阵 +
 * 线性重采样）—— 驱动行为不可控，两条路都必须通，否则就是"某台机器无声"。
 *
 * 线程安全：wr 只由采集线程写、rd 只由主线程写，都是 4 字节对齐的 LONG，
 * x86 上天然原子；不做临界区（每 5ms 一次的开销不值得）。
 * ==================================================== */
typedef struct {
  IAudioClient* client;
  IAudioCaptureClient* cap;
  HANDLE thread;
  volatile LONG running;
  volatile LONG wr;          /* 累计写入帧数（绝对） */
  volatile LONG rd;          /* 累计取走帧数（绝对） */
  short* ring;               /* AUD_RING × AUD_CH 个 s16 */
  float* conv;               /* 转换暂存：源格式 → float 立体声 */
  float* res;                /* 重采样输出（srcRate != 48k 时才用） */
  int srcRate, srcCh, srcBits, srcFloat;
  double phase;              /* 重采样相位（跨包延续，不能每次归零） */
  int peak;                  /* 最近一段的峰值 0..100（给电平条） */
  int dropped;               /* 因环形满被丢掉的帧数（排障用） */
} AudioIn;

typedef struct {
  AudioIn sys;
  AudioIn mic;
  int haveSys;
  int haveMic;
  short bufS[AUD_CHUNK * AUD_CH];
  short bufM[AUD_CHUNK * AUD_CH];
} AudioMix;

static int audioLevel(AudioIn* a) {
  if (!a) return 0;
  int v = a->peak;
  a->peak = 0;               /* 取一次清零：报的是「这一秒的峰值」 */
  return v < 0 ? 0 : (v > 100 ? 100 : v);
}

/* 单包 → 48k 立体声 s16 入环。data 可能是 NULL（SILENT 标志），此时整包静音。 */
static void audioPush(AudioIn* a, const BYTE* data, UINT32 frames, DWORD flags) {
  if (!a || !a->ring || frames == 0) return;
  const int ch = a->srcCh > 0 ? a->srcCh : 2;
  const int silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || !data;
  UINT32 i;

  /* 1) 反交错 + 归一化到 float 立体声（单声道复制到左右；>2 声道取前两路） */
  for (i = 0; i < frames; i++) {
    float l = 0.f, r = 0.f;
    if (!silent) {
      if (a->srcFloat) {
        const float* f = (const float*)(data + (size_t)i * ch * 4);
        if (ch == 1) { l = r = f[0]; } else { l = f[0]; r = f[1]; }
      } else if (a->srcBits == 16) {
        const short* s = (const short*)(data + (size_t)i * ch * 2);
        if (ch == 1) { l = r = s[0] / 32768.f; } else { l = s[0] / 32768.f; r = s[1] / 32768.f; }
      } else {
        /* 32 位整型（含 24-in-32）：高位对齐，取前 16 位即可 */
        const int* v = (const int*)(data + (size_t)i * ch * 4);
        if (ch == 1) { l = r = (float)(v[0] >> 16) / 32768.f; }
        else { l = (float)(v[0] >> 16) / 32768.f; r = (float)(v[1] >> 16) / 32768.f; }
      }
    }
    a->conv[i * 2] = l;
    a->conv[i * 2 + 1] = r;
  }

  /* 2) 采样率对齐（设备只给了 44.1k 之类时才走到这儿） */
  const float* out = a->conv;
  int outN = (int)frames;
  if (a->srcRate != AUD_RATE && a->res) {
    const double step = (double)a->srcRate / (double)AUD_RATE;
    int k = 0;
    while (a->phase < (double)frames - 1.0 && k < AUD_RING) {
      const int i0 = (int)a->phase;
      const float fr = (float)(a->phase - (double)i0);
      a->res[k * 2]     = a->conv[i0 * 2]     * (1.f - fr) + a->conv[i0 * 2 + 2]     * fr;
      a->res[k * 2 + 1] = a->conv[i0 * 2 + 1] * (1.f - fr) + a->conv[i0 * 2 + 3] * fr;
      k++;
      a->phase += step;
    }
    a->phase -= (double)frames;
    if (a->phase < 0.0) a->phase = 0.0;
    if (k <= 0) return;
    out = a->res;
    outN = k;
  }

  /* 3) 入环：满了丢**最旧的**。丢新的会让音频越录越晚（听起来像慢半拍），
     丢旧的只是把抖动期间的老数据扔掉，时间轴始终贴着当前。 */
  LONG w = a->wr;
  LONG r = a->rd;
  int space = AUD_RING - (int)(w - r);
  if (outN > space) {
    a->dropped += outN - space;
    a->rd = r = w - (AUD_RING - outN);
    if (r < 0) r = 0;
  }
  int peak = a->peak;
  for (int j = 0; j < outN; j++) {
    const int idx = (int)((w + j) % AUD_RING);
    float l = out[j * 2], r2 = out[j * 2 + 1];
    if (l > 1.f) l = 1.f; else if (l < -1.f) l = -1.f;
    if (r2 > 1.f) r2 = 1.f; else if (r2 < -1.f) r2 = -1.f;
    const short sl = (short)(l * 32767.f);
    const short sr = (short)(r2 * 32767.f);
    a->ring[idx * 2] = sl;
    a->ring[idx * 2 + 1] = sr;
    int al = sl < 0 ? -sl : sl;
    int ar = sr < 0 ? -sr : sr;
    if (al > peak) peak = al;
    if (ar > peak) peak = ar;
  }
  a->wr = w + outN;
  a->peak = peak > 32767 ? 100 : (int)((long long)peak * 100 / 32767);
}

/* 取 n 帧（不够就有多少取多少），返回实际帧数 */
static int audioPull(AudioIn* a, short* dst, int frames) {
  if (!a || !a->ring || frames <= 0) return 0;
  const int avail = (int)(a->wr - a->rd);
  if (avail <= 0) return 0;
  int n = frames < avail ? frames : avail;
  LONG r = a->rd;
  for (int i = 0; i < n; i++) {
    const int idx = (int)((r + i) % AUD_RING);
    dst[i * 2] = a->ring[idx * 2];
    dst[i * 2 + 1] = a->ring[idx * 2 + 1];
  }
  a->rd = r + n;
  return n;
}

/* 暂停/恢复：把积压直接扔掉，否则恢复瞬间会先听到"暂停前那一段" */
static void audioDiscard(AudioIn* a) {
  if (!a) return;
  a->rd = a->wr;
  a->peak = 0;
}

static DWORD WINAPI audioThread(LPVOID param) {
  AudioIn* a = (AudioIn*)param;
  CoInitializeEx(NULL, COINIT_MULTITHREADED);
  while (InterlockedCompareExchange(&a->running, 1, 1)) {
    UINT32 pkts = 0;
    if (FAILED(a->cap->lpVtbl->GetNextPacketSize(a->cap, &pkts))) {
      Sleep(20);
      continue;
    }
    while (pkts) {
      BYTE* data = NULL;
      UINT32 frames = 0;
      DWORD flags = 0;
      if (FAILED(a->cap->lpVtbl->GetBuffer(a->cap, &data, &frames, &flags, NULL, NULL))) break;
      if (frames) audioPush(a, data, frames, flags);
      a->cap->lpVtbl->ReleaseBuffer(a->cap, frames);
      if (FAILED(a->cap->lpVtbl->GetNextPacketSize(a->cap, &pkts))) { pkts = 0; break; }
    }
    Sleep(AUD_POLL_MS);
  }
  CoUninitialize();
  return 0;
}

static void audioClose(AudioIn* a) {
  if (!a) return;
  if (a->thread) {
    InterlockedExchange(&a->running, 0);
    WaitForSingleObject(a->thread, 1000);
    CloseHandle(a->thread);
    a->thread = NULL;
  }
  if (a->client) { a->client->lpVtbl->Stop(a->client); }
  if (a->cap) { a->cap->lpVtbl->Release(a->cap); a->cap = NULL; }
  if (a->client) { a->client->lpVtbl->Release(a->client); a->client = NULL; }
  if (a->ring) { free(a->ring); a->ring = NULL; }
  if (a->conv) { free(a->conv); a->conv = NULL; }
  if (a->res) { free(a->res); a->res = NULL; }
  a->wr = 0;
  a->rd = 0;
}

/* 打开一路设备并开始采集。render=1 走渲染端点（系统声环回），0 走麦克风。
   失败返回 HRESULT —— 调用方只降级不致命（视频必须照录）。 */
static HRESULT audioOpen(AudioIn* a, int render) {
  ZeroMemory(a, sizeof(*a));
  IMMDeviceEnumerator* en = NULL;
  IMMDevice* dev = NULL;
  HRESULT hr = CoCreateInstance(&ORB_CLSID_MMDeviceEnumerator, NULL, CLSCTX_ALL,
                                &ORB_IID_IMMDeviceEnumerator, (void**)&en);
  if (FAILED(hr)) return hr;
  hr = en->lpVtbl->GetDefaultAudioEndpoint(en, render ? eRender : eCapture, eConsole, &dev);
  if (SUCCEEDED(hr)) {
    hr = dev->lpVtbl->Activate(dev, &ORB_IID_IAudioClient, CLSCTX_ALL, NULL, (void**)&a->client);
  }
  if (dev) dev->lpVtbl->Release(dev);
  en->lpVtbl->Release(en);
  if (FAILED(hr)) { audioClose(a); return hr; }

  const DWORD base = render ? AUDCLNT_STREAMFLAGS_LOOPBACK : 0;
  WAVEFORMATEX req;
  ZeroMemory(&req, sizeof(req));
  req.wFormatTag = WAVE_FORMAT_PCM;
  req.nChannels = AUD_CH;
  req.nSamplesPerSec = AUD_RATE;
  req.wBitsPerSample = 16;
  req.nBlockAlign = (WORD)(AUD_CH * 2);
  req.nAvgBytesPerSec = AUD_RATE * AUD_CH * 2;
  req.cbSize = 0;

  hr = a->client->lpVtbl->Initialize(a->client, AUDCLNT_SHAREMODE_SHARED,
            base | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
            5000000, 0, &req, NULL);
  if (SUCCEEDED(hr)) {
    a->srcRate = AUD_RATE;
    a->srcCh = AUD_CH;
    a->srcBits = 16;
    a->srcFloat = 0;
  } else {
    /* 旧驱动 / 环回不支持自动转换：退回设备混音格式，自己转 */
    WAVEFORMATEX* mix = NULL;
    hr = a->client->lpVtbl->GetMixFormat(a->client, &mix);
    if (SUCCEEDED(hr) && mix) {
      HRESULT hr2 = a->client->lpVtbl->Initialize(a->client, AUDCLNT_SHAREMODE_SHARED,
                      base, 5000000, 0, mix, NULL);
      if (SUCCEEDED(hr2)) {
        a->srcRate = (int)mix->nSamplesPerSec;
        a->srcCh = (int)mix->nChannels;
        a->srcBits = (int)mix->wBitsPerSample;
        a->srcFloat = (mix->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) ? 1 : 0;
        if (mix->wFormatTag == WAVE_FORMAT_EXTENSIBLE &&
            ((WAVEFORMATEXTENSIBLE*)mix)->SubFormat.Data1 == 3) a->srcFloat = 1;
        /* 超出支持范围就认输（24bit 紧密打包这类罕见格式不做） */
        if (a->srcRate < 8000 || a->srcCh < 1 || a->srcCh > 8 ||
            (!a->srcFloat && a->srcBits != 16 && a->srcBits != 32)) {
          hr = E_FAIL;
        } else {
          hr = S_OK;
        }
      } else {
        hr = hr2;
      }
      CoTaskMemFree(mix);
    }
    if (FAILED(hr)) { audioClose(a); return hr; }
  }

  hr = a->client->lpVtbl->GetService(a->client, &ORB_IID_IAudioCaptureClient, (void**)&a->cap);
  if (FAILED(hr)) { audioClose(a); return hr; }

  a->ring = (short*)malloc(sizeof(short) * AUD_RING * AUD_CH);
  a->conv = (float*)malloc(sizeof(float) * AUD_RING * AUD_CH);
  a->res  = (float*)malloc(sizeof(float) * AUD_RING * AUD_CH);
  if (!a->ring || !a->conv || !a->res) { audioClose(a); return E_OUTOFMEMORY; }

  hr = a->client->lpVtbl->Start(a->client);
  if (FAILED(hr)) { audioClose(a); return hr; }

  /* 把开流前积压的老数据倒掉：环回会把启动前约 200ms 的内容一起吐出来 */
  for (int guard = 0; guard < 64; guard++) {
    UINT32 pkts = 0;
    if (FAILED(a->cap->lpVtbl->GetNextPacketSize(a->cap, &pkts)) || pkts == 0) break;
    while (pkts) {
      BYTE* data = NULL;
      UINT32 frames = 0;
      DWORD flags = 0;
      if (FAILED(a->cap->lpVtbl->GetBuffer(a->cap, &data, &frames, &flags, NULL, NULL))) break;
      a->cap->lpVtbl->ReleaseBuffer(a->cap, frames);
      if (FAILED(a->cap->lpVtbl->GetNextPacketSize(a->cap, &pkts))) { pkts = 0; break; }
    }
  }

  InterlockedExchange(&a->running, 1);
  a->thread = CreateThread(NULL, 0, audioThread, a, 0, NULL);
  if (!a->thread) { audioClose(a); return E_FAIL; }
  return S_OK;
}

/* 按 --audio 档位开设备。返回实际可用路数（0 = 全失败，照录视频）。 */
static int audioStartAll(AudioMix* m, int mode) {
  ZeroMemory(m, sizeof(*m));
  if (mode == AUDIO_NONE) return 0;
  if (mode == AUDIO_SYSTEM || mode == AUDIO_MIX) {
    if (SUCCEEDED(audioOpen(&m->sys, 1))) m->haveSys = 1;
    else fprintf(stderr, "orb-cap: 系统声采集打开失败（继续）\n"), fflush(stderr);
  }
  if (mode == AUDIO_MIC || mode == AUDIO_MIX) {
    if (SUCCEEDED(audioOpen(&m->mic, 0))) m->haveMic = 1;
    else fprintf(stderr, "orb-cap: 麦克风采集打开失败（继续）\n"), fflush(stderr);
  }
  return (m->haveSys ? 1 : 0) + (m->haveMic ? 1 : 0);
}

static void audioStopAll(AudioMix* m) {
  if (m->haveSys) { audioClose(&m->sys); m->haveSys = 0; }
  if (m->haveMic) { audioClose(&m->mic); m->haveMic = 0; }
}

/* 混音取数：返回实际凑出的帧数（两路都缺时为 0）。
   两路都存在时各自 0.72 增益再相加，超出 s16 就硬限幅 —— 这就是设置页写的
   "自动混音限幅"。短的那一路按静音补，绝不让另一路停下来等它。 */
static int audioPullMixed(AudioMix* m, short* dst, int frames) {
  if (frames <= 0 || frames > AUD_CHUNK) return 0;
  int ns = 0, nm = 0;
  if (m->haveSys) ns = audioPull(&m->sys, m->bufS, frames);
  if (m->haveMic) nm = audioPull(&m->mic, m->bufM, frames);
  const int n = ns > nm ? ns : nm;
  if (n <= 0) return 0;
  if (ns < n) ZeroMemory(m->bufS + ns * AUD_CH, sizeof(short) * (size_t)(n - ns) * AUD_CH);
  if (nm < n) ZeroMemory(m->bufM + nm * AUD_CH, sizeof(short) * (size_t)(n - nm) * AUD_CH);
  if (m->haveSys && m->haveMic) {
    for (int i = 0; i < n * AUD_CH; i++) {
      int v = (int)(((int)m->bufS[i] + (int)m->bufM[i]) * 0.72f);
      if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
      dst[i] = (short)v;
    }
  } else {
    const short* src = m->haveSys ? m->bufS : m->bufM;
    memcpy(dst, src, sizeof(short) * (size_t)n * AUD_CH);
  }
  return n;
}

/* 写一个音频样本（t / dur 都是 100ns 单位，和视频同一套时间基准） */
static HRESULT writeAudioSample(IMFSinkWriter* writer, DWORD stream,
                                const short* pcm, int frames, LONGLONG t, LONGLONG dur) {
  const DWORD need = (DWORD)frames * AUD_FRAME_BYTES;
  IMFMediaBuffer* buf = NULL;
  HRESULT hr = MFCreateMemoryBuffer(need, &buf);
  if (FAILED(hr)) return hr;
  BYTE* dst = NULL;
  hr = buf->lpVtbl->Lock(buf, &dst, NULL, NULL);
  if (SUCCEEDED(hr)) {
    memcpy(dst, pcm, need);
    buf->lpVtbl->Unlock(buf);
    hr = buf->lpVtbl->SetCurrentLength(buf, need);
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
  return hr;
}

/* 给 SinkWriter 加第二条流（AAC 输出 / PCM 输入）。失败不致命：
   返回非 S_OK 时调用方把音频整个关掉，成片退化成纯视频（和旧版一致）。 */
static HRESULT writerAddAudio(IMFSinkWriter* writer, DWORD* outStream) {
  IMFMediaType* outT = NULL;
  IMFMediaType* inT = NULL;
  DWORD stream = 0;
  HRESULT hr = MFCreateMediaType(&outT);
  if (SUCCEEDED(hr)) hr = outT->lpVtbl->SetGUID(outT, &MF_MT_MAJOR_TYPE, &MFMediaType_Audio);
  if (SUCCEEDED(hr)) hr = outT->lpVtbl->SetGUID(outT, &MF_MT_SUBTYPE, &MFAudioFormat_AAC);
  if (SUCCEEDED(hr)) hr = outT->lpVtbl->SetUINT32(outT, &MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
  if (SUCCEEDED(hr)) hr = outT->lpVtbl->SetUINT32(outT, &MF_MT_AUDIO_SAMPLES_PER_SECOND, AUD_RATE);
  if (SUCCEEDED(hr)) hr = outT->lpVtbl->SetUINT32(outT, &MF_MT_AUDIO_NUM_CHANNELS, AUD_CH);
  /* 输出侧的 AVG_BYTES_PER_SECOND 就是 AAC 码率（128kbps），不是采样率乘积 */
  if (SUCCEEDED(hr)) hr = outT->lpVtbl->SetUINT32(outT, &MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 16000);
  if (SUCCEEDED(hr)) hr = outT->lpVtbl->SetUINT32(outT, &MF_MT_AAC_PAYLOAD_TYPE, 0);
  if (SUCCEEDED(hr)) hr = outT->lpVtbl->SetUINT32(outT, &MF_MT_AAC_AUDIO_PROFILE_LEVEL_INDICATION, 0x29);
  if (SUCCEEDED(hr)) hr = writer->lpVtbl->AddStream(writer, outT, &stream);

  if (SUCCEEDED(hr)) hr = MFCreateMediaType(&inT);
  if (SUCCEEDED(hr)) hr = inT->lpVtbl->SetGUID(inT, &MF_MT_MAJOR_TYPE, &MFMediaType_Audio);
  if (SUCCEEDED(hr)) hr = inT->lpVtbl->SetGUID(inT, &MF_MT_SUBTYPE, &MFAudioFormat_PCM);
  if (SUCCEEDED(hr)) hr = inT->lpVtbl->SetUINT32(inT, &MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
  if (SUCCEEDED(hr)) hr = inT->lpVtbl->SetUINT32(inT, &MF_MT_AUDIO_SAMPLES_PER_SECOND, AUD_RATE);
  if (SUCCEEDED(hr)) hr = inT->lpVtbl->SetUINT32(inT, &MF_MT_AUDIO_NUM_CHANNELS, AUD_CH);
  if (SUCCEEDED(hr)) hr = inT->lpVtbl->SetUINT32(inT, &MF_MT_AUDIO_BLOCK_ALIGNMENT, AUD_FRAME_BYTES);
  if (SUCCEEDED(hr)) hr = inT->lpVtbl->SetUINT32(inT, &MF_MT_AUDIO_AVG_BYTES_PER_SECOND, AUD_RATE * AUD_FRAME_BYTES);
  if (SUCCEEDED(hr)) hr = inT->lpVtbl->SetUINT32(inT, &MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE);
  if (SUCCEEDED(hr)) hr = writer->lpVtbl->SetInputMediaType(writer, stream, inT, NULL);

  if (inT) inT->lpVtbl->Release(inT);
  if (outT) outT->lpVtbl->Release(outT);
  if (FAILED(hr)) return hr;
  *outStream = stream;
  return S_OK;
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
  printf("orb-cap.exe --out <file.mp4> [--fps 30] [--bitrate 6000000] [--display 0] [--rect x y w h] [--audio none|system|mic|mix]\n");
  printf("  --rect x y w h : record only this region (physical pixels, origin = display top-left)\n");
  printf("  --audio        : none (default) | system (loopback) | mic | mix\n");
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
  /* 区域录制：hasRect = 0 时整屏（与 v1 行为完全一致） */
  int rectX = 0, rectY = 0, rectW = 0, rectH = 0;
  int hasRect = 0;
  int audioMode = AUDIO_NONE;

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
    } else if (!wcscmp(argv[i], L"--rect") && i + 4 < argc) {
      /* 四个数一组（x y w h）。缺参数不能默默降级成整屏 ——
         用户明确要的是"只录那块"，录出整屏比失败更糟。 */
      rectX = _wtoi(argv[++i]);
      rectY = _wtoi(argv[++i]);
      rectW = _wtoi(argv[++i]);
      rectH = _wtoi(argv[++i]);
      hasRect = 1;
    } else if (!wcscmp(argv[i], L"--audio") && i + 1 < argc) {
      const WCHAR* v = argv[++i];
      if (!_wcsicmp(v, L"system")) audioMode = AUDIO_SYSTEM;
      else if (!_wcsicmp(v, L"mic")) audioMode = AUDIO_MIC;
      else if (!_wcsicmp(v, L"mix")) audioMode = AUDIO_MIX;
      else if (!_wcsicmp(v, L"none")) audioMode = AUDIO_NONE;
      else {
        char lossy[64];
        w2u8(v, lossy, sizeof(lossy));
        emitErr(E_INVALIDARG, "不支持的 --audio %s（none|system|mic|mix）", lossy);
        LocalFree(argv);
        return 2;
      }
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
  if (hasRect && (rectW <= 0 || rectH <= 0)) {
    emitErr(E_INVALIDARG, "不合理的 --rect %d %d %d %d（宽高必须为正）", rectX, rectY, rectW, rectH);
    return 2;
  }

  /* ---- COM / MF ---- */
  int coInited = 0, mfInited = 0;
  Dup dup;
  ZeroMemory(&dup, sizeof(dup));
  IMFSinkWriter* writer = NULL;
  DWORD stream = 0;
  DWORD astream = 0;        /* 音频流编号；0 = 没开音频 */
  AudioMix amix;
  ZeroMemory(&amix, sizeof(amix));
  LONGLONG aEnc = 0;        /* 已写入的音频帧数（暂停不增，与 encoded 同源） */
  short pcmBuf[AUD_CHUNK * AUD_CH];
  BYTE* gdiBuf = NULL;      /* GDI 兜底首帧（桌面静止时用） */
  int gdiHeld = 0;          /* 当前帧是不是 GDI 那张 */
  int gdiTries = 0;
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
    emitErr((long)hr, "桌面复制初始化失败（%ux%u，格式 %u，旋转 %d）",
            dup.w, dup.h, (unsigned)dup.srcFmt, (int)dup.rot);
    goto cleanup;
  }

  /* 奇数边长会让 H.264 编码器拒绝：裁到偶数（丢的是最后一列/行，肉眼不可见）。
     区域录制时再按 --rect 把矩形夹到屏幕内（见 calcEncRect）。
     注意基准是 **outW/outH**（旋转后的尺寸）—— --rect 的坐标是用户看到的
     屏幕坐标，竖屏时它跟源纹理的宽高是反的。 */
  UINT encW = 0, encH = 0, srcX = 0, srcY = 0;
  calcEncRect(dup.outW, dup.outH, hasRect, rectX, rectY, rectW, rectH, &srcX, &srcY, &encW, &encH);

  if (encW < 16 || encH < 16) {
    emitErr(E_FAIL, "桌面尺寸过小，无法编码：%ux%u%s", dup.outW, dup.outH,
            hasRect ? "（区域小于 16px）" : "");
    goto cleanup;
  }

  /* 一行诊断进 stderr（主进程收进日志）：用户报"录不出/录歪了"时，
     这里能立刻看出是格式协商失败、还是旋转没认对，不用让他截图猜。 */
  {
    const char* fmtName = "?";
    switch (dup.srcFmt) {
      case DXGI_FORMAT_B8G8R8A8_UNORM: fmtName = "BGRA8"; break;
      case DXGI_FORMAT_B8G8R8A8_UNORM_SRGB: fmtName = "BGRA8/sRGB"; break;
      case DXGI_FORMAT_R8G8B8A8_UNORM: fmtName = "RGBA8"; break;
      case DXGI_FORMAT_R10G10B10A2_UNORM: fmtName = "HDR10(R10G10B10A2)"; break;
      case DXGI_FORMAT_R16G16B16A16_FLOAT: fmtName = "scRGB(RGBA16F)"; break;
      default: break;
    }
    const char* rotName = "0";
    switch (dup.rot) {
      case DXGI_MODE_ROTATION_ROTATE90: rotName = "90"; break;
      case DXGI_MODE_ROTATION_ROTATE180: rotName = "180"; break;
      case DXGI_MODE_ROTATION_ROTATE270: rotName = "270"; break;
      default: break;
    }
    fprintf(stderr, "orb-cap: 桌面 %ux%u %s 旋转%s -> 输出 %ux%u\n",
            dup.w, dup.h, fmtName, rotName, dup.outW, dup.outH);
    fflush(stderr);
  }

  /* GDI 兜底首帧的位图（失败就算了，只影响"静止桌面能不能出片"） */
  gdiBuf = (BYTE*)malloc((size_t)dup.outW * (size_t)dup.outH * 4);

  /* 音频必须**先于** writer 打开：
     ① AAC 流的采样率跟实际设备走（设备只给 44.1k 时要据此决定是否重采样）；
     ② AddStream 必须在 BeginWriting 之前，打不开就得在建 writer 时就不带音频。
     任一路失败只降级不致命 —— 视频是主产物，没有声音也要能出片。 */
  int audioRoutes = audioStartAll(&amix, audioMode);

  hr = writerCreate(outPath, encW, encH, fps, bitrate, audioRoutes > 0,
                    &writer, &stream, &astream);
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

  /* 音频实际状态（协议外的行，主进程只记日志/回传 UI，不认识也不会出错）：
     off 的三种原因分开报，用户问"为什么没声音"时日志里能一眼看出卡在哪。 */
  if (audioMode == AUDIO_NONE) {
    emit("audio off disabled");
  } else if (astream && audioRoutes > 0) {
    emit("audio on %d %d %s", AUD_RATE, AUD_CH,
         (amix.haveSys && amix.haveMic) ? "system+mic" : (amix.haveSys ? "system" : "mic"));
  } else if (audioRoutes > 0) {
    emit("audio off no-encoder");
  } else {
    emit("audio off no-device");
  }

  /* 区域裁剪的实际落点只进 stderr（主进程收进日志）：stdout 是协议通道，
     多一行就要多一处解析分支，不值得。 */
  if (hasRect) {
    fprintf(stderr, "orb-cap: rect %u,%u %ux%u (display %ux%u%s)\n",
            srcX, srcY, encW, encH, dup.outW, dup.outH,
            dup.rot != DXGI_MODE_ROTATION_IDENTITY ? "，已按屏幕旋转还原" : "");
    fflush(stderr);
  }

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
          /* 暂停期间不写音频样本 —— 积压必须扔掉，否则恢复瞬间先听到
             "暂停前那一段"，而且会把后面的话越推越晚 */
          if (amix.haveSys) audioDiscard(&amix.sys);
          if (amix.haveMic) audioDiscard(&amix.mic);
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
          calcEncRect(dup.outW, dup.outH, hasRect, rectX, rectY, rectW, rectH,
                      &srcX, &srcY, &encW, &encH);
          stopMode = 1;
          break;
        }
      } else if (FAILED(har) && har != DXGI_ERROR_WAIT_TIMEOUT) {
        emitErr((long)har, "暂停态取帧失败");
        exitCode = 4;
        goto cleanup;
      }
      /* 暂停态继续把音频丢掉，别让环形缓冲一直满着 */
      if (amix.haveSys) audioDiscard(&amix.sys);
      if (amix.haveMic) audioDiscard(&amix.mic);
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
        D3D11_TEXTURE2D_DESC srcDesc;
        ZeroMemory(&srcDesc, sizeof(srcDesc));
        tex->lpVtbl->GetDesc(tex, &srcDesc);
        if (srcDesc.Format != dup.srcFmt && fmtSupported(srcDesc.Format)) {
          dupRestage(&dup, srcDesc.Format);
        }
        dup.ctx->lpVtbl->CopyResource(dup.ctx, (ID3D11Resource*)dup.staging, (ID3D11Resource*)tex);
        haveFrame = 1;
        gdiHeld = 0;                 /* 真帧来了，兜底位图下台 */
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
        calcEncRect(dup.outW, dup.outH, hasRect, rectX, rectY, rectW, rectH,
                    &srcX, &srcY, &encW, &encH);
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

    /* 首帧兜底：桌面完全静止时 DXGI 一帧都不给（WAIT_TIMEOUT 是常态），
       500ms 还没拿到就用 GDI 抓一张顶上 —— 静止桌面、锁屏、录文档页都不能
       被"没有采集到任何帧"判死。抓到之后 CFR 会重复它，等真有变化再切回纹理。 */
    if (!haveFrame && gdiBuf && gdiTries < 5 && clockRecNs(&clock) > 5000000LL) {
      gdiTries++;
      if (gdiGrab(dup.outW, dup.outH, gdiBuf)) {
        haveFrame = 1;
        gdiHeld = 1;
        fprintf(stderr, "orb-cap: 桌面 500ms 无变化，GDI 抓首帧兜底\n");
        fflush(stderr);
      }
    }

    /* ---- 4) 到点就写：没有新帧就重复上一帧（CFR 的关键） ---- */
    while (haveFrame && !clock.paused && clockRecNs(&clock) >= encoded * dur) {
      LONGLONG t = encoded * dur;
      hr = writeFrame(writer, stream, &dup, gdiHeld ? gdiBuf : NULL, dup.outW * 4,
                      encW, encH, srcX, srcY, t, dur);
      if (FAILED(hr)) {
        emitErr((long)hr, "写入帧失败（第 %lld 帧）", encoded);
        exitCode = 5;
        goto cleanup;
      }
      /* 音频跟着视频帧走：目标样本数 = (已写帧数+1) × 48000 / fps。
         这样两条轨各自从同一条逻辑时钟派生，暂停/掉帧都不会累积错位。
         每帧最多切 1024 帧一个样本（AAC 编码器按包缓冲，块大小无所谓）。 */
      if (astream) {
        const LONGLONG target = (LONGLONG)(encoded + 1) * AUD_RATE / fps;
        while (aEnc < target) {
          int need = (int)(target - aEnc);
          if (need > AUD_CHUNK) need = AUD_CHUNK;
          int got = audioPullMixed(&amix, pcmBuf, need);
          if (got < need) {
            /* 抖动（缺一点点）就先欠着，下一帧补；只有缺口大到 125ms 才补静音，
               否则音轨会比画面短一截（导出后音画长度不一致）。 */
            const LONGLONG deficitNs = (target - aEnc) * 10000000LL / AUD_RATE;
            if (got <= 0 && deficitNs < AUD_STARVE_NS) break;
            if (got < 0) got = 0;
            ZeroMemory(pcmBuf + (size_t)got * AUD_CH,
                       sizeof(short) * (size_t)(need - got) * AUD_CH);
          }
          const LONGLONG t0 = (LONGLONG)aEnc * 10000000LL / AUD_RATE;
          const LONGLONG t1 = (LONGLONG)(aEnc + need) * 10000000LL / AUD_RATE;
          const HRESULT ahr = writeAudioSample(writer, astream, pcmBuf, need, t0, t1 - t0);
          if (FAILED(ahr)) {
            /* 音频写坏了不能连累视频：关掉音频后半段继续录画面 */
            fprintf(stderr, "orb-cap: 音频写入失败（0x%08lX），后续只录画面\n", (unsigned long)ahr);
            fflush(stderr);
            astream = 0;
            break;
          }
          aEnc += need;
        }
      }
      encoded++;
      if (encoded >= nextLogAt) {
        emit("frame %lld %d %d", encoded, audioLevel(&amix.sys), audioLevel(&amix.mic));
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
  audioStopAll(&amix);      /* 采集线程必须在 MFShutdown / 释放 writer 之前停 */
  if (gdiBuf) { free(gdiBuf); gdiBuf = NULL; }
  if (writer) { writer->lpVtbl->Release(writer); writer = NULL; }
  /* 异常退出（含 abort 之外的所有非 0 退出）：把半成品删掉，
     别在 recordings 里留一个没人认领的坏文件。 */
  if (exitCode != 0 && writerOpened) DeleteFileW(outPath);
  dupDestroy(&dup);
  if (mfInited) MFShutdown();
  if (coInited) CoUninitialize();
  return exitCode;
}
