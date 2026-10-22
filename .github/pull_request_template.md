## 改了什么

<!-- 一两句话。涉及多个模块时按模块列点。 -->

## 为什么

<!-- 关联 Issue：Closes #123。没有 Issue 的话，说明这个改动解决了什么实际问题。 -->

## 怎么验证的

- [ ] `node orb\selftest.mjs` 全绿
- [ ] 真启动过一次应用，`orb/desktop/.orbdata/orb.log` 里没有 `No handler registered` / `[panel:error] JS REJECT` / `render-process-gone`
- [ ] 跑过相关探针：<!-- 如 docs/_recbar_verify.js / _grad_probe.js / _glassbg_verify.js / _theme_probe.js -->
- [ ] 界面改动附了截图（前后对比更好）

## 自查

- [ ] **没有在 `main.js` 模块顶层碰 ready-gated API**（`screen` / `BrowserWindow` / `session` / `dialog` / `Tray` / `globalShortcut` / `nativeTheme` / `powerMonitor` / `desktopCapturer`）
- [ ] 渲染层改动遵守 CSP：图标全内联 SVG，零外部资源，无 `<a href="http">`
- [ ] 动效只动 `transform` / `opacity`，没给 `backdrop-filter` 做动画、没给消息区加模糊
- [ ] 新增文件已加进 `orb/pack.cjs` 的 `APP_FILES`（否则发布版会静默失效）
- [ ] 没有把令牌、日志、录屏产物、调参截图带进提交

## 影响面

<!-- 有没有动打包契约 / 包内路径 / 存储目录结构 / IPC 白名单？有的话请说明兼容性。 -->
