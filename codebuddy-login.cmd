@echo off
chcp 65001 >nul
title CodeBuddy CLI - 登录（ORB 后台 Agent）

REM ---------------------------------------------------------------
REM 登录 CodeBuddy CLI —— ORB 后台通道用的官方原生 CLI。
REM
REM 本脚本是**通用版**：只调用 PATH 里的 codebuddy，不写任何本机绝对路径。
REM 私有目录（例如某人机器上没加进 PATH 的安装位置）请写进 orb/local.conf
REM 的 wbCli 字段，或设环境变量 ORB_WB_CLI —— 该文件已在 .gitignore 中排除，
REM 不会进仓库、也不会进发布包。
REM
REM 为什么必须自己装：codebuddy 是腾讯专有软件，本项目不随包分发它
REM （再分发即侵权）。没装的话这里会提示，装完再运行本脚本即可。
REM
REM 端口冲突的由来（保留这段清理，别删）：
REM   WorkBuddy 桌面端启动时会把自己的服务端口写进环境变量
REM       SERVER__PORT=<桌面端口>
REM       CODEBUDDY_SERVICE_PROXY_URL=http://127.0.0.1:<桌面端口>/...
REM   若 ORB 是从桌面端派生的终端里启动的，就会继承这两个变量，
REM   codebuddy 子进程随后去绑「桌面已占用的同一个端口」→ EADDRINUSE 未捕获异常秒退。
REM   这里显式清空，让它自己选端口。
REM ---------------------------------------------------------------

set "SERVER__PORT="
set "CODEBUDDY_SERVICE_PROXY_URL="
set "ELECTRON_RUN_AS_NODE="

echo 正在启动 CodeBuddy CLI 的交互式登录…
echo 若提示「不是内部或外部命令」，说明本机还没装 CLI 或它不在 PATH 中：
echo   1) 按官方渠道安装 CodeBuddy CLI
echo   2) 或设置环境变量 ORB_WB_CLI 指向 codebuddy.exe
echo   3) 或在 orb/local.conf 里写 {"wbCli":"…完整路径…"}
echo.

codebuddy login

echo.
echo CLI 已退出（退出码 %ERRORLEVEL%）。
echo 登录成功后：
echo   1) 关闭本窗口
echo   2) 回到 ORB，设置 → 通道 → 「重新检测」
echo   3) 再发一次后台任务即可
echo.
pause
