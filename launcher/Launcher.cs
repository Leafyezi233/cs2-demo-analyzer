using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Windows.Forms;

static class Launcher
{
    static Process child;
    static NotifyIcon tray;
    static string baseDir;
    static int port;
    static string logPath;
    static readonly object logLock = new object();
    static string url;

    [STAThread]
    static int Main(string[] args)
    {
        baseDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        logPath = Path.Combine(baseDir, "日志.txt");
        bool trayTest = args.Length > 0 && args[0] == "--check-tray";
        bool checkMode = args.Length > 0 && (args[0] == "--check" || trayTest);

        port = FindFreePort(8765, 8784);
        if (port == 0) { Fail("8765-8784 端口都被占用，请关闭其它程序后重试。"); return 2; }
        url = "http://127.0.0.1:" + port + "/";

        string py = Path.Combine(baseDir, "runtime" + Path.DirectorySeparatorChar + "python.exe");
        if (!File.Exists(py)) { Fail("找不到 " + py); return 3; }

        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(py, "-m app.main");
            psi.WorkingDirectory = baseDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.EnvironmentVariables["CS2_PANEL_PORT"] = port.ToString();
            psi.EnvironmentVariables["CS2_PANEL_NO_BROWSER"] = "1";
            psi.EnvironmentVariables["PYTHONUTF8"] = "1";
            psi.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";
            psi.EnvironmentVariables["PYTHONDONTWRITEBYTECODE"] = "1";
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = new System.Text.UTF8Encoding(false);
            psi.StandardErrorEncoding = new System.Text.UTF8Encoding(false);
            child = new Process();
            child.StartInfo = psi;
            child.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { Log(e.Data); };
            child.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { Log(e.Data); };
            child.EnableRaisingEvents = true;
            child.Start();
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();
        }
        catch (Exception ex) { Fail("启动失败：" + ex.Message); return 4; }

        bool ok = WaitForHealth(checkMode ? 60 : 90);
        if (checkMode)
        {
            Log("CHECK " + (ok ? "OK" : "FAIL") + " port=" + port);
            if (trayTest)
            {
                Application.EnableVisualStyles();
                MakeTray();
                System.Windows.Forms.Timer t = new System.Windows.Forms.Timer();
                t.Interval = 3000;
                t.Tick += delegate(object s, EventArgs e) { tray.Visible = false; Application.Exit(); };
                t.Start();
                Application.Run();
                Log("TRAY OK");
            }
            StopChild();
            return ok ? 0 : 5;
        }
        if (!ok)
        {
            MessageBox.Show("服务在 90 秒内没有启动成功。请查看同目录下的 日志.txt。",
                            "CS2 数据面板", MessageBoxButtons.OK, MessageBoxIcon.Error);
            StopChild();
            return 5;
        }

        if (Environment.GetEnvironmentVariable("CS2_PANEL_NO_OPEN") != "1") OpenBrowser();
        Application.EnableVisualStyles();
        MakeTray();
        Application.Run();
        return 0;
    }

    static void Fail(string msg)
    {
        Log("ERROR " + msg);
        MessageBox.Show(msg, "CS2 数据面板", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    static void Log(string line)
    {
        if (line == null) return;
        lock (logLock)
        {
            try
            {
                File.AppendAllText(logPath,
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + line + Environment.NewLine,
                    new System.Text.UTF8Encoding(true));
            }
            catch { }
        }
    }

    static int FindFreePort(int from, int to)
    {
        for (int p = from; p <= to; p++)
        {
            try
            {
                TcpListener l = new TcpListener(IPAddress.Loopback, p);
                l.Start();
                l.Stop();
                return p;
            }
            catch { }
        }
        return 0;
    }

    static bool WaitForHealth(int seconds)
    {
        DateTime deadline = DateTime.UtcNow.AddSeconds(seconds);
        while (DateTime.UtcNow < deadline)
        {
            if (child.HasExited) { Log("子进程已退出，退出码 " + child.ExitCode); return false; }
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url + "api/health");
                req.Timeout = 2500;
                req.Proxy = null;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                {
                    if ((int)resp.StatusCode == 200) return true;
                }
            }
            catch { }
            Thread.Sleep(500);
        }
        return false;
    }

    static void OpenBrowser()
    {
        try { Process.Start(url); }
        catch (Exception ex) { Log("打开浏览器失败：" + ex.Message); }
    }

    static void MakeTray()
    {
        ContextMenuStrip menu = new ContextMenuStrip();
        menu.Items.Add("打开面板", null, delegate(object s, EventArgs e) { OpenBrowser(); });
        menu.Items.Add("打开数据目录", null, delegate(object s, EventArgs e)
        {
            try { Process.Start(Path.Combine(baseDir, "数据")); }
            catch (Exception ex) { Log("打开数据目录失败：" + ex.Message); }
        });
        menu.Items.Add("查看日志", null, delegate(object s, EventArgs e)
        {
            try { Process.Start("notepad.exe", logPath); }
            catch (Exception ex) { Log("打开日志失败：" + ex.Message); }
        });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出", null, delegate(object s, EventArgs e) { StopChild(); tray.Visible = false; Application.Exit(); });

        tray = new NotifyIcon();
        tray.Icon = SystemIcons.Application;
        tray.Text = "CS2 数据面板（" + url + "）";
        tray.ContextMenuStrip = menu;
        tray.Visible = true;
        tray.DoubleClick += delegate(object s, EventArgs e) { OpenBrowser(); };
        tray.ShowBalloonTip(3000, "CS2 数据面板已启动", url, ToolTipIcon.Info);
    }

    static void StopChild()
    {
        try
        {
            if (child != null && !child.HasExited)
            {
                child.Kill();
                child.WaitForExit(8000);
            }
        }
        catch (Exception ex) { Log("停止子进程失败：" + ex.Message); }
    }
}
