/* ============================================================================
 * ORB 语音输入与识别模块
 *
 * 复制主界面「麦克风按钮 → 录音 → 实时把转写文本灌进输入框」这一套交互，
 * 识别引擎做成可插拔：
 *   - auto：   本地 Whisper 就绪 → 用本地（离线、免 Key）；否则**静默**回落浏览器引擎，
 *              仅在状态行标一句"当前用浏览器引擎"（DESIGN §5.4）。本地端点由 asr-status
 *              探测确认，未安装时语音功能不残、也不弹任何报错。
 *   - browser：浏览器内置 Web Speech API（webkitSpeechRecognition）。
 *             零配置，但依赖 Chromium 的语音服务、需联网，且在部分 Electron
 *             构建里可能拿不到 Google 的识别后端，此时改用 whisper 引擎。
 *   - whisper：OpenAI 兼容的 /audio/transcriptions 端点。录音拿到后由主进程
 *             （asr-transcribe）代为 POST，绕开面板 CSP，形态对齐 WorkBuddy
 *             主界面「daemon 负责网络、渲染层只管录音与展示」的架构。
 *
 * 文本落点与主界面一致：识别结果写进聊天输入框（transcript），用户可继续编辑后发送。
 * ========================================================================== */
(function () {
  "use strict";
  const input = document.getElementById("input");
  if (!input) return;                     // 只在面板页生效

  /* 本地 Whisper 的端点（与 bridge 的 ASR_PORT 默认值一致；端口被占用时以面板状态为准） */
  const LOCAL_ASR_ENDPOINT = "http://127.0.0.1:19876/v1/audio/transcriptions";

  /* hasKey：主进程 get-state **不会**回传 apiKey（密钥只在真正发请求时才取），
     只给 hasKey 这个布尔。之前这里只看 cfg.apiKey，于是从来拿不到真值，
     结果是"明明保存过 Key，设置里却一直显示尚未设置"。 */
  const cfg = { engine: "auto", endpoint: "", apiKey: "", hasKey: false, model: "whisper-1", lang: "zh-CN" };
  function keySaved() { return !!(cfg.apiKey || cfg.hasKey); }
  function keyStateText() { return keySaved() ? "（已保存，留空则不修改）" : "（尚未设置）"; }

  /* Web Speech API 错误码 → 人话。
     国内网络 / Electron 下最常见的是 "network"：Chromium 的在线语音识别后端不可达，
     浏览器内置引擎此时是没法用的，只能改用 Whisper 端点——所以这里给出可操作的引导，
     而不是把原始错误码（network）直接甩给用户。 */
  const SR_ERR = {
    network: "浏览器语音服务连不上：Chromium 的在线识别后端在本机不可达（国内网络 / Electron 常见）。可改用 Whisper 端点，或在「设置 → 语音」一键安装本地离线识别。",
    "service-not-allowed": "浏览器语音服务被禁用（Electron 下常见）。可改用 Whisper 端点，或在「设置 → 语音」一键安装本地离线识别。",
    "not-allowed": "麦克风权限被拒绝：请在系统隐私设置里允许 ORB 使用麦克风。",
    "audio-capture": "没有检测到可用的麦克风设备。",
    "language-not-supported": "当前语言不被浏览器识别服务支持。",
  };
  /** 需要用户去「视觉 → 语音识别」改配置的错误。 */
  function needSettings(errCode) { return errCode === "network" || errCode === "service-not-allowed"; }

  /* ------- SVG 图标（不用 emoji，保持原项目风格）------- */
  const MIC_SVG = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">'
    + '<path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Z"/>'
    + '<path fill="currentColor" d="M18 11a1 1 0 1 0-2 0 4 4 0 0 1-8 0 1 1 0 0 0-2 0 6 6 0 0 0 5 5.91V19H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-2.09A6 6 0 0 0 18 11Z"/>'
    + '</svg>';
  const STOP_SVG = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">'
    + '<rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor"/></svg>';

  /* ------- 构建麦克风按钮与状态提示 ------- */
  /* 位置：发送栏最左侧（左下角），与「自动/前台/视觉/后台」同排。
     这是原版布局，面板里的引导文案也这么写（「语音输入用左下角麦克风按钮」）。
     回退链只为容错：万一 .sendrow 结构变了，退到 compose，最差也要挂上，
     绝不能因为锚点缺失就把按钮整个丢掉（前几轮就是这么丢的）。 */
  const micBtn = document.createElement("button");
  micBtn.className = "iconbtn icononly";
  micBtn.id = "mic";
  micBtn.type = "button";
  micBtn.title = "语音输入（点击开始/停止）";
  micBtn.innerHTML = MIC_SVG;

  const statusEl = document.createElement("span");
  statusEl.className = "muted";
  statusEl.id = "voice-status";
  statusEl.style.display = "none";

  const compose = input.closest(".compose");
  const sendrow = compose ? compose.querySelector(".sendrow") : null;
  if (sendrow) {
    sendrow.insertBefore(micBtn, sendrow.firstChild);
  } else if (compose) {
    compose.appendChild(micBtn);
  } else {
    input.insertAdjacentElement("afterend", micBtn);
  }
  const coord = document.getElementById("coord");
  if (coord) coord.insertAdjacentElement("afterend", statusEl);
  else if (sendrow) sendrow.appendChild(statusEl);
  else micBtn.insertAdjacentElement("afterend", statusEl);

  /* ------- 运行状态 ------- */
  let active = false;
  let recognizer = null;       // { stop() }
  let finalText = "";          // 已确认文本（停止前不会丢失）
  let lastPartial = "";        // 当前实时预览

  function applyCfg(c) { if (c) Object.assign(cfg, c); syncEngineUI(); }
  function isRecording() { return active; }

  function setActive(on, msg) {
    active = on;
    micBtn.classList.toggle("on", on);
    micBtn.innerHTML = on ? STOP_SVG : MIC_SVG;
    statusEl.style.display = on ? "" : "none";
    if (on) statusEl.textContent = msg || "聆听中…点击停止";
  }

  function renderInput() {
    const base = finalText || "";
    const tail = lastPartial ? (base && !/\s$/.test(base) ? " " : "") + lastPartial : "";
    input.value = base + tail;
    input.dispatchEvent(new Event("input"));   // 触发 autoGrow
    input.focus();
  }

  /* ---------------- 浏览器内置识别（Web Speech API）---------------- */
  function startBrowser(hint) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      statusEl.style.display = "";
      statusEl.textContent = "当前环境不支持浏览器语音识别，请在设置里改用 Whisper 端点";
      return;
    }
    finalText = input.value && !/^\s*$/.test(input.value) ? input.value.replace(/\s+$/, "") + " " : "";
    lastPartial = "";
    const r = new SR();
    r.lang = cfg.lang || "zh-CN";
    r.interimResults = true;
    r.continuous = true;
    r.maxAlternatives = 1;

    r.onresult = (e) => {
      let inter = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText += res[0].transcript;
        else inter += res[0].transcript;
      }
      lastPartial = inter;
      renderInput();
    };
    r.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      /* 剩下的错误（network / service-not-allowed / not-allowed …）不会自己好。
         不先把 active 置 false，onend 里就会立刻 r.start() 再来一轮，
         于是每秒重试好几次、按钮一直停在"停止"图标上，看上去像卡死。 */
      active = false;
      recognizer = null;
      setActive(false);
      statusEl.style.display = "";
      statusEl.style.cursor = "";
      statusEl.onclick = null;
      statusEl.textContent = SR_ERR[e.error] || ("识别出错：" + e.error);
      if (needSettings(e.error)) {
        statusEl.textContent += "（点此打开语音设置）";
        statusEl.style.cursor = "pointer";
        statusEl.title = "打开「视觉 → 语音识别」设置";
        statusEl.onclick = () => window.dispatchEvent(new CustomEvent("orb-open-voice-settings"));
      }
    };
    r.onend = () => {
      // 仍在录音就自动续上，保证连续说话不断流（主界面也是流式转写）
      if (active) { try { r.start(); } catch (_) {} }
      else finalize();
    };

    recognizer = { stop: () => { try { r.stop(); } catch (_) {} } };
    // hint=true 表示这是 auto 模式回落上来的：在聆听提示里写清"本次用浏览器引擎、需联网"，
    // 并告诉用户可一键安装本地识别（DESIGN §5.4：不弹错，只标一行）
    setActive(true, hint
      ? "聆听中…（浏览器引擎，需联网；装本地识别后可离线）"
      : "聆听中…点击停止");
    try { r.start(); } catch (err) {
      setActive(false);
      statusEl.style.display = "";
      statusEl.textContent = "启动失败：" + err.message;
    }
  }

  /* ---------------- Whisper 端点（录音 → 主进程代理 POST）----------------
   * override：auto 模式走本地 Whisper 时传入 { endpoint, apiKey:"" , model }，
   * 不污染用户自己配的 cfg.endpoint（那是给"whisper 显式锁定"模式用的）。 */
  function startWhisper(override) {
    const endpoint = (override && override.endpoint) || cfg.endpoint;
    const apiKey = (override && "apiKey" in override) ? override.apiKey : cfg.apiKey;
    const model = (override && override.model) || cfg.model;
    if (!endpoint) {
      statusEl.style.display = "";
      statusEl.textContent = "未配置 Whisper 端点，请在设置里填写";
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      statusEl.style.display = "";
      statusEl.textContent = "当前环境不支持麦克风采集";
      return;
    }
    finalText = input.value && !/^\s*$/.test(input.value) ? input.value.replace(/\s+$/, "") + " " : "";
    lastPartial = "";
    setActive(true, "录音中…说完点击停止");

    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      const mr = new MediaRecorder(stream);
      const chunks = [];
      mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        /* setActive(false) 会把 statusEl 设成 display:none，
           所以"没录到声音 / 识别失败"这类失败提示必须在 setActive 之后
           再写一遍文案并把 display 放开 —— 否则用户永远看不到失败原因。 */
        if (!chunks.length) {
          setActive(false);
          statusEl.style.display = "";
          statusEl.textContent = "没录到声音";
          return;
        }
        const blob = new Blob(chunks);
        const b64 = await blobToBase64(blob);
        statusEl.textContent = "识别中…";
        const res = await window.orb.asrTranscribe({
          endpoint, apiKey, model,
          audioB64: b64, mime: blob.type || "audio/webm",
        });
        if (res && res.ok) {
          finalText += res.text || "";
          lastPartial = "";
          renderInput();
          setActive(false);
        } else {
          setActive(false);
          statusEl.style.display = "";
          statusEl.textContent = "识别失败：" + ((res && res.error) || "未知错误");
        }
      };
      mr.start();
      recognizer = { stop: () => { if (mr.state !== "inactive") mr.stop(); } };
    }).catch((err) => {
      setActive(false);
      statusEl.style.display = "";
      statusEl.textContent = "麦克风打开失败：" + err.message;
    });
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(",")[1]);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  /* ---------------- 控制 ---------------- */
  function start() {
    if (active) return;
    const eng = cfg.engine || "auto";
    if (eng === "whisper") { startWhisper(); return; }
    if (eng === "auto") {
      /* auto：先问本地 Whisper 就绪没有（installed + 权重 + 服务在跑）。
         就绪 → 走本地（离线、免 Key）；没就绪 → 静默走浏览器引擎，只标一行提示。
         探测失败（bridge 没起来等）同样按浏览器引擎处理，绝不弹错。 */
      Promise.resolve(window.orb.asrStatus ? window.orb.asrStatus() : null)
        .then((s) => {
          if (s && s.ok && s.installed && s.modelDownloaded && s.running) {
            startWhisper({ endpoint: LOCAL_ASR_ENDPOINT, apiKey: "", model: "whisper-1" });
          } else {
            startBrowser(true);
          }
        })
        .catch(() => startBrowser(true));
      return;
    }
    startBrowser();
  }
  function stop() {
    if (recognizer) { try { recognizer.stop(); } catch (_) {} recognizer = null; }
    setActive(false);
  }
  function finalize() {
    lastPartial = "";
    renderInput();
  }

  micBtn.addEventListener("click", () => { if (active) stop(); else start(); });

  // 悬浮球右键「语音输入」触发
  if (window.orb && window.orb.onVoiceStart) {
    window.orb.onVoiceStart(() => { if (!active) start(); });
  }

  /* ---------------- 设置面板接线（视觉遮罩内的「语音识别」区）---------------- */
  function toggleFields() {
    const eng = document.getElementById("v-engine");
    const on = eng && eng.value === "whisper";
    ["v-endpoint-field", "v-key-field", "v-model-field"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.style.display = on ? "" : "none";
    });
  }
  function syncEngineUI() {
    const eng = document.getElementById("v-engine");
    if (eng) {
      eng.value = cfg.engine || "auto";
      const ep = document.getElementById("v-endpoint");
      if (ep) ep.value = cfg.endpoint || "";
      const md = document.getElementById("v-model");
      if (md) md.value = cfg.model || "whisper-1";
      const ks = document.getElementById("v-keystate");
      if (ks) ks.textContent = keyStateText();
      toggleFields();
    }
  }
  function initSheet() {
    const eng = document.getElementById("v-engine");
    if (!eng) return;
    eng.value = cfg.engine || "auto";
    const ep = document.getElementById("v-endpoint");
    if (ep) ep.value = cfg.endpoint || "";
  const md = document.getElementById("v-model");
  if (md) md.value = cfg.model || "whisper-1";
  const ks = document.getElementById("v-keystate");
  if (ks) ks.textContent = keyStateText();
  const kp = document.getElementById("v-key");
    if (kp) kp.value = "";
    toggleFields();
    eng.addEventListener("change", toggleFields);

    const paste = document.getElementById("v-paste");
    if (paste) paste.addEventListener("click", async () => {
      try {
        const t = (await window.orb.readClipboard()) || "";
        const v = t.trim();
        if (!v) { setMsg("剪贴板是空的。先复制 API Key，再点这里。"); return; }
        document.getElementById("v-key").value = v;
        setMsg("已从剪贴板填入 " + v.length + " 个字符（点「保存」才会生效）。");
      } catch (e) { setMsg("读取剪贴板失败：" + e.message); }
    });

    const test = document.getElementById("v-voice-test");
    if (test) test.addEventListener("click", async () => {
      const eng = cfg.engine || "auto";
      if (eng === "auto") {
        // auto：说实话 —— 本地就绪说本地，没就绪明确告诉用户"本次用浏览器引擎、需联网"，
        // 并指向一键安装（DESIGN §5.4）
        setMsg("正在检测本地识别环境…");
        const s = await Promise.resolve(window.orb.asrStatus ? window.orb.asrStatus() : null).catch(() => null);
        if (s && s.ok && s.installed && s.modelDownloaded && s.running) {
          setMsg("自动模式：本地离线识别已就绪，点麦克风按钮后直接说话即可（离线可用、免 Key）。");
        } else {
          setMsg("未启用本地识别，本次将使用浏览器引擎（需联网）；需要离线识别可在下方「本地离线识别」一键安装。");
        }
      } else if (eng === "browser") {
        setMsg("浏览器内置引擎：点麦克风按钮后直接说话即可（依赖系统/Chromium 语音服务，需联网；若识别无反应，请改用 Whisper 端点）。");
      } else {
        if (!cfg.endpoint) { setMsg("Whisper 端点未填。"); return; }
        setMsg("Whisper 端点：" + cfg.endpoint + " / 模型 " + (cfg.model || "whisper-1") + "，点麦克风开始录音识别。");
      }
    });

    // 复用视觉设置的「保存」按钮：额外把语音配置一并落盘
    const saveBtn = document.getElementById("v-save");
    if (saveBtn) saveBtn.addEventListener("click", () => {
      const engine = document.getElementById("v-engine").value;
      const endpoint = document.getElementById("v-endpoint").value.trim();
      const model = document.getElementById("v-model").value.trim() || "whisper-1";
      const key = document.getElementById("v-key").value.trim();
      const patch = { engine, endpoint, model, apiKey: key || null };
      window.orb.setVoice(patch).then((r) => {
        if (r && r.ok) {
          applyCfg(r.voice);
          const ks = document.getElementById("v-keystate");
          if (ks) ks.textContent = keyStateText();
          const msg = document.getElementById("v-msg");
          if (msg) msg.textContent = "语音设置已保存。";
        }
      });
    });
  }
  function setMsg(t) {
    const m = document.getElementById("v-msg");
    if (m) m.textContent = t;
  }

  /* ---------------- 启动 ---------------- */
  if (window.orb && window.orb.getState) {
    window.orb.getState().then((s) => {
      if (s && s.voice) applyCfg(s.voice);
      initSheet();
    });
  } else {
    initSheet();
  }

  window.OrbVoice = { start, stop, isRecording, applyCfg };
})();
