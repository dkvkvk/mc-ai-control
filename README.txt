Minecraft AI 控制面板
=====================

一个把「Minecraft 服务端 + AI 机器人（mindcraft）」管起来的中文侧边栏面板。
像素风界面，参考了 GitHub 上的 MC 风格前端（aubergine-ux/MC-Website-Template、
katorlys/OreUI）的做法：0 圆角 + 硬边框 + 内嵌高光做方块立体感。

用法
----
1. 双击 MC-AI-Control.exe
2. 面板会在一个独立窗口里打开（不占浏览器标签页，不是普通网页）
3. 「概览」里点「启动服务器」→ 等 10~30 秒 → 再点「启动全部（机器人）」
4. 去 PCL2 连接 127.0.0.1:25565
5. 在「快速派活」或「AI 机器人」页直接打字下指令

多开机器人
----------
「AI 机器人」页可以同时挂多个机器人：

- 在「添加机器人」里填名字（3~16 位字母/数字/下划线）→ 点「添加并启动」
- 每个机器人是独立进程，共用一个服务端和一个 MindServer
- 每一行都能单独「启动 / 停止 / 删除」；也可以「启动全部 / 停止全部」
- 派活时用左边的下拉选「发给全部」或某个具体机器人
- 所有机器人都共享同一套模型配置，换模型就改那一行的「模型 / 接口地址」

原理：MindServer(8080) 支持 create-agent / start-agent / stop-agent / destroy-agent
事件，面板只跑一个 MindServer，机器人动态创建，所以多开不需要多开面板、也不会
互相顶号。

> 发言固定用 en 发出。填 zh 会让 mindcraft 调 google-translate-api-x 把每句话翻译
> 一遍，国内基本连不上，还会把报错刷进聊天。机器人本来就跟着你的提问语言回答。

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
- 机器人清单：   %LOCALAPPDATA%\MC-AI-Control\app\data\bots.json
- 机器人日志：   %LOCALAPPDATA%\MC-AI-Control\app\data\mindserver.log
- 窗口数据：     %LOCALAPPDATA%\MC-AI-Control\browser

几个说明
--------
- 关掉窗口后，面板后端约 1 分钟自动退出，不会留后台进程。
- 关面板**不会**杀掉服务器和机器人（方便你关面板继续挂机）：
  MindServer 的输出写到文件而不是管道，管道断开也不会把它带走。
  下次打开面板会显示为「外部启动」，此时面板不能远程关服务器——
  要关请在服务器控制台输入 stop；机器人可以点「关闭 MindServer」。
- 「停止」按钮只在「本面板启动的」服务器上可用，这是有意的安全设计。
- 端口默认：服务端 25565，MindServer 8080，面板后端 4599（被占用会自动往后找）。
