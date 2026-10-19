Minecraft AI 控制面板
=====================

一个把「Minecraft 服务端 + AI 机器人（mindcraft）」管起来的中文侧边栏面板。
像素风界面，参考了 GitHub 上的 MC 风格前端（aubergine-ux/MC-Website-Template、
katorlys/OreUI）的做法：0 圆角 + 硬边框 + 内嵌高光做方块立体感。

用法
----
1. 双击 MC-AI-Control.exe
2. 面板会在一个独立窗口里打开（不占浏览器标签页，不是普通网页）
3. 「概览」里点「启动服务器」→ 等 10~30 秒 → 再点「启动机器人」
4. 去 PCL2 连接 127.0.0.1:25565
5. 在「快速派活」或「AI 机器人」页直接打字下指令

运行前提
--------
- Node.js（必装，AI 机器人和面板后端都跑在 node 上）
  找不到时，可把 node.exe 的完整路径写进：%LOCALAPPDATA%\MC-AI-Control\node.txt
- Java 17（跑 1.20.1 服务端）
- Edge 或 Chrome（用来显示面板窗口，系统一般自带）

文件都在哪
----------
- 程序解压目录：%LOCALAPPDATA%\MC-AI-Control\app
- 面板配置：     %LOCALAPPDATA%\MC-AI-Control\app\data\config.json
- 窗口数据：     %LOCALAPPDATA%\MC-AI-Control\browser

几个说明
--------
- 关掉窗口后，后端约 1 分钟自动退出，不会留后台进程。
- 由面板启动的服务器 / 机器人不会因为关窗口而被杀掉（方便你关面板继续挂机）；
  下次打开面板会显示为「外部启动」，此时面板不能远程关它——
  要关请在服务器控制台输入 stop。
- 「停止」按钮只在「本面板启动的」进程上可用，这是有意的安全设计。
- 端口默认：服务端 25565，MindServer 8080，面板后端 4599（被占用会自动往后找）。
