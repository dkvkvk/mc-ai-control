// ---------------------------------------------------------------------------
//  Minecraft AI 控制面板 —— 单文件启动器
//  作用：解压内嵌的前端/后端 → 拉起 node 后端 → 用 Edge 应用窗口打开面板
//  设计取舍：本机 Electron 启动即崩（Chromium 初始化访问违例），而 Chromium
//            窗口本身正常，所以用系统自带的 Edge（--app 模式）当壳，稳定性最好。
// ---------------------------------------------------------------------------
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class Program
{
    static readonly string DataDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MC-AI-Control");
    static readonly string AppDir = Path.Combine(DataDir, "app");
    static readonly string BrowserDir = Path.Combine(DataDir, "browser");
    static readonly string RendererDir = Path.Combine(AppDir, "renderer");

    // 内嵌资源 → 目标文件
    static readonly string[,] Assets = new string[,]
    {
        { "server.js",            "server.js" },
        { "index.html",           @"renderer\index.html" },
        { "styles.css",           @"renderer\styles.css" },
        { "app.js",               @"renderer\app.js" },
        { "README.txt",           "使用说明.txt" },
    };

    static readonly string LogFile = Path.Combine(DataDir, "launcher.log");

    static void Log(string msg)
    {
        try
        {
            File.AppendAllText(LogFile, DateTime.Now.ToString("HH:mm:ss.fff") + "  " + msg + Environment.NewLine, Encoding.UTF8);
        }
        catch { }
    }

    [STAThread]
    static void Main(string[] args)
    {
        try
        {
            Log("======== 启动 ========");
            Directory.CreateDirectory(AppDir);
            Directory.CreateDirectory(RendererDir);
            Directory.CreateDirectory(BrowserDir);
            Log("目录已就绪: " + AppDir);

            ExtractAssets();
            Log("资源释放完成");

            // 1) 已有后端在跑就直接复用，避免开出两个
            int port = FindRunningBackend();
            bool started = false;
            Log("已有后端端口: " + port);

            if (port == 0)
            {
                string node = FindNode();
                Log("node.exe: " + (node ?? "(未找到)"));
                if (node == null)
                {
                    Log("错误：找不到 node.exe");
                    MessageBox.Show(
                        "没有找到 node.exe。\n\n请先安装 Node.js（https://nodejs.org），\n" +
                        "或把 node.exe 的完整路径写进：\n" + Path.Combine(DataDir, "node.txt"),
                        "Minecraft AI 控制面板", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }
                StartBackend(node);
                port = WaitForBackend(25);
                started = true;
                Log("后端端口: " + port);
                if (port == 0)
                {
                    Log("错误：后端启动失败");
                    MessageBox.Show("后端启动失败（端口无响应）。\n\n可手动排查：\n  cd \"" + AppDir + "\"\n  \"" + node + "\" server.js",
                        "Minecraft AI 控制面板", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }
            }

            OpenPanelWindow(port);
            Log("窗口已拉起，启动器退出");
            GC.KeepAlive(started);
        }
        catch (Exception ex)
        {
            Log("异常: " + ex);
            MessageBox.Show("启动出错：" + ex.Message, "Minecraft AI 控制面板", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    // ---------------------------------------------------------------- 资源释放
    static void ExtractAssets()
    {
        var asm = Assembly.GetExecutingAssembly();
        for (int i = 0; i < Assets.GetLength(0); i++)
        {
            string res = Assets[i, 0];
            string target = Path.Combine(AppDir, Assets[i, 1]);
            Directory.CreateDirectory(Path.GetDirectoryName(target));
            try
            {
                using (Stream s = asm.GetManifestResourceStream(res))
                {
                    if (s == null) continue;
                    using (var sr = new StreamReader(s, Encoding.UTF8))
                    {
                        string content = sr.ReadToEnd();
                        // 内容有变化才覆盖（避免破坏用户改动 & 省 IO）
                        if (File.Exists(target) && File.ReadAllText(target, Encoding.UTF8) == content) continue;
                        File.WriteAllText(target, content, new UTF8Encoding(false));
                    }
                }
            }
            catch { /* 单个资源失败不影响其它 */ }
        }
    }

    // ---------------------------------------------------------------- node 定位
    static string FindNode()
    {
        string cfg = Path.Combine(DataDir, "node.txt");
        try
        {
            if (File.Exists(cfg))
            {
                string p = File.ReadAllText(cfg).Trim();
                if (p.Length > 0 && File.Exists(p)) return p;
            }
        }
        catch { }

        string pathVar = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string dir in pathVar.Split(';'))
        {
            if (dir.Trim().Length == 0) continue;
            try
            {
                string c = Path.Combine(dir.Trim(), "node.exe");
                if (File.Exists(c)) return c;
            }
            catch { }
        }

        string[] guesses =
        {
            @"D:\nodejs\node.exe",
            @"C:\Program Files\nodejs\node.exe",
            @"C:\Program Files (x86)\nodejs\node.exe",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\nodejs\node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), @"npm\node.exe")
        };
        foreach (string g in guesses) if (File.Exists(g)) return g;
        return null;
    }

    // ---------------------------------------------------------------- 后端进程
    static void StartBackend(string node)
    {
        var psi = new ProcessStartInfo
        {
            FileName = node,
            Arguments = "server.js",
            WorkingDirectory = AppDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        var p = Process.Start(psi);
        // 异步把输出丢掉，避免管道写满把后端卡死
        p.OutputDataReceived += (s, e) => { };
        p.ErrorDataReceived += (s, e) => { };
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
    }

    static int FindRunningBackend()
    {
        for (int port = 4599; port < 4615; port++)
            if (Ping(port)) return port;
        return 0;
    }

    static int WaitForBackend(int seconds)
    {
        var end = DateTime.UtcNow.AddSeconds(seconds);
        while (DateTime.UtcNow < end)
        {
            for (int port = 4599; port < 4615; port++)
                if (Ping(port)) return port;
            Thread.Sleep(400);
        }
        return 0;
    }

    static bool Ping(int port)
    {
        try
        {
            using (var tcp = new TcpClient())
            {
                var ar = tcp.BeginConnect("127.0.0.1", port, null, null);
                if (!ar.AsyncWaitHandle.WaitOne(300)) return false;
                tcp.EndConnect(ar);

                using (var wc = new WebClient())
                {
                    wc.Encoding = Encoding.UTF8;
                    string s = wc.DownloadString("http://127.0.0.1:" + port + "/api/status");
                    return s.Contains("\"server\"");
                }
            }
        }
        catch { return false; }
    }

    // ---------------------------------------------------------------- 打开窗口
    static void OpenPanelWindow(int port)
    {
        string url = "http://127.0.0.1:" + port + "/";
        string browser = FindBrowser();
        if (browser == null)
        {
            Process.Start(url);   // 退回默认浏览器
            return;
        }
        var psi = new ProcessStartInfo
        {
            FileName = browser,
            Arguments = "--app=" + url +
                        " --window-size=1200,860 --window-position=120,60" +
                        " --user-data-dir=\"" + BrowserDir + "\"" +
                        " --no-first-run --no-default-browser-check --disable-features=Translate",
            UseShellExecute = false,
        };
        Process.Start(psi);
    }

    static string FindBrowser()
    {
        string[] paths =
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Google\Chrome\Application\chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Google\Chrome\Application\chrome.exe"),
        };
        foreach (string p in paths) if (File.Exists(p)) return p;
        return null;
    }
}
