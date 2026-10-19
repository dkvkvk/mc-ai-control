'use strict';
/**
 * Minecraft AI 控制面板 —— Electron 主进程
 * 职责：窗口 + 服务器/机器人进程管理 + 日志采集 + 派活
 */
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');

// ---------------------------------------------------------------- 配置
const DEFAULTS = {
    serverDir: 'C:/Users/20646/Desktop/杂/minecraft-ai/server',
    mindcraftDir: 'C:/Users/20646/Desktop/杂/minecraft-ai/mindcraft',
    javaPath: 'D:/Java/bin/java.exe',
    javaArgs: '-Xms1G -Xmx2G',
    serverPort: 25565,
    mindserverPort: 8080,
    botName: 'AIBot',
    sayScript: 'say.mjs',
    nodePath: 'node',
};

function configPath() {
    return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig() {
    try {
        const raw = fs.readFileSync(configPath(), 'utf8');
        return { ...DEFAULTS, ...JSON.parse(raw) };
    } catch {
        return { ...DEFAULTS };
    }
}

function saveConfig(cfg) {
    const p = configPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
    return p;
}

let cfg = DEFAULTS;

// ---------------------------------------------------------------- 日志缓冲
const LOG_LIMIT = 1500;
const logs = [];            // {t, src, line}
const chats = [];           // {t, from, text}
const players = new Map();  // name -> joinTime

let win = null;

function emitLog(src, line) {
    if (!line) return;
    const trimmed = String(line).replace(/\r$/, '');
    if (!trimmed.trim()) return;
    const entry = { t: Date.now(), src, line: trimmed };
    logs.push(entry);
    if (logs.length > LOG_LIMIT) logs.shift();
    // 聊天行：<Name> message
    const m = trimmed.match(/<([^>]{1,32})>\s(.*)$/);
    if (m) {
        const c = { t: entry.t, from: m[1], text: m[2] };
        chats.push(c);
        if (chats.length > 400) chats.shift();
        if (win && !win.isDestroyed()) win.webContents.send('chat', c);
    }
    // 上下线
    const j = trimmed.match(/([A-Za-z0-9_]{1,16}) joined the game/);
    const l = trimmed.match(/([A-Za-z0-9_]{1,16}) left the game/);
    if (j) players.set(j[1], Date.now());
    if (l) players.delete(l[1]);
    if (win && !win.isDestroyed()) win.webContents.send('log', entry);
}

function pipeLines(stream, src) {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
        buf += chunk;
        const parts = buf.split('\n');
        buf = parts.pop();
        for (const p of parts) emitLog(src, p);
    });
    stream.on('end', () => { if (buf) emitLog(src, buf); });
}

// 服务端 latest.log 跟随（外部启动的实例也能看到聊天）
let logTimer = null;
let logOffset = 0;
function startLogTail() {
    stopLogTail();
    logOffset = 0;
    logTimer = setInterval(() => {
        const file = path.join(cfg.serverDir, 'logs', 'latest.log');
        let st;
        try { st = fs.statSync(file); } catch { return; }
        if (st.size < logOffset) logOffset = 0;             // 轮转
        if (st.size === logOffset) return;
        try {
            const fd = fs.openSync(file, 'r');
            const len = Math.min(st.size - logOffset, 512 * 1024);
            const buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, logOffset);
            fs.closeSync(fd);
            logOffset = st.size;
            buf.toString('utf8').split('\n').forEach((l) => {
                const clean = l.replace(/^\[[^\]]*\]\s*(\[[^\]]*\]\s*)?/, '');
                if (/joined the game|left the game|<[^>]+>\s|Done \(|Starting minecraft server/.test(l)) {
                    emitLog('server', clean);
                }
            });
        } catch { /* 文件被占用时跳过这一拍 */ }
    }, 900);
}
function stopLogTail() {
    if (logTimer) { clearInterval(logTimer); logTimer = null; }
}

// ---------------------------------------------------------------- 进程
let serverProc = null;
let botProc = null;
let serverOwned = false;

function probePort(port, host = '127.0.0.1') {
    return new Promise((resolve) => {
        const s = new net.Socket();
        const finish = (ok) => { s.destroy(); resolve(ok); };
        s.setTimeout(800);
        s.once('connect', () => finish(true));
        s.once('timeout', () => finish(false));
        s.once('error', () => finish(false));
        s.connect(port, host);
    });
}

function tailFile(file, maxBytes = 64 * 1024) {
    try {
        const st = fs.statSync(file);
        const start = Math.max(0, st.size - maxBytes);
        const len = st.size - start;
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, start);
        fs.closeSync(fd);
        return buf.toString('utf8');
    } catch { return ''; }
}

async function getStatus() {
    const [serverUp, mindUp] = await Promise.all([
        probePort(cfg.serverPort),
        probePort(cfg.mindserverPort),
    ]);
    return {
        server: {
            up: serverUp,
            owned: serverOwned && !!serverProc,
            pid: serverProc ? serverProc.pid : null,
            port: cfg.serverPort,
        },
        bot: {
            up: mindUp,
            running: !!botProc,
            pid: botProc ? botProc.pid : null,
            name: cfg.botName,
        },
        players: [...players.keys()],
        paths: {
            serverDir: cfg.serverDir,
            mindcraftDir: cfg.mindcraftDir,
            serverDirOk: fs.existsSync(path.join(cfg.serverDir, 'server.jar')),
            mindcraftDirOk: fs.existsSync(path.join(cfg.mindcraftDir, 'main.js')),
            javaOk: fs.existsSync(cfg.javaPath),
        },
        configFile: configPath(),
    };
}

function startServer() {
    return new Promise(async (resolve) => {
        if (await probePort(cfg.serverPort)) {
            serverOwned = false;
            startLogTail();
            resolve({ ok: true, msg: '检测到 25565 已在监听（可能是外部启动的服务器），已接管日志监听。' });
            return;
        }
        const jar = path.join(cfg.serverDir, 'server.jar');
        if (!fs.existsSync(jar)) return resolve({ ok: false, msg: `找不到服务端：${jar}` });
        const args = [...cfg.javaArgs.split(/\s+/).filter(Boolean), '-jar', 'server.jar', 'nogui'];
        emitLog('panel', `启动服务器：${cfg.javaPath} ${args.join(' ')}`);
        let p;
        try {
            p = spawn(cfg.javaPath, args, { cwd: cfg.serverDir, windowsHide: true });
        } catch (e) {
            return resolve({ ok: false, msg: '启动失败：' + e.message });
        }
        serverProc = p;
        serverOwned = true;
        pipeLines(p.stdout, 'server');
        pipeLines(p.stderr, 'server');
        p.on('exit', (code) => {
            emitLog('panel', `服务器进程已退出（code=${code}）`);
            serverProc = null; serverOwned = false;
        });
        startLogTail();
        resolve({ ok: true, msg: '服务器启动中，约 10~30 秒后可在游戏内连接。' });
    });
}

function stopServer() {
    return new Promise((resolve) => {
        if (!serverProc || !serverOwned) {
            return resolve({ ok: false, msg: '当前服务器不是面板启动的，无法从面板关闭。请手动在控制台输入 stop。' });
        }
        emitLog('panel', '正在停止服务器（发送 stop 指令）…');
        try { serverProc.stdin.write('stop\n'); } catch { /* ignore */ }
        const t = setTimeout(() => {
            if (serverProc) { try { spawn('taskkill', ['/pid', String(serverProc.pid), '/T', '/F'], { windowsHide: true }); } catch {} }
        }, 15000);
        serverProc.once('exit', () => { clearTimeout(t); stopLogTail(); resolve({ ok: true, msg: '服务器已停止。' }); });
    });
}

function startBot() {
    return new Promise(async (resolve) => {
        if (botProc) return resolve({ ok: false, msg: '机器人进程已在运行。' });
        if (await probePort(cfg.mindserverPort)) return resolve({ ok: false, msg: '检测到 8080 已被占用（MindServer 已在跑），请先关闭它。' });
        const main = path.join(cfg.mindcraftDir, 'main.js');
        if (!fs.existsSync(main)) return resolve({ ok: false, msg: `找不到 main.js：${main}` });
        emitLog('panel', '启动 AI 机器人（mindcraft）…');
        let p;
        try {
            p = spawn(cfg.nodePath, ['main.js'], { cwd: cfg.mindcraftDir, windowsHide: true });
        } catch (e) {
            return resolve({ ok: false, msg: '启动失败：' + e.message });
        }
        botProc = p;
        pipeLines(p.stdout, 'bot');
        pipeLines(p.stderr, 'bot');
        p.on('exit', (code) => {
            emitLog('panel', `机器人进程已退出（code=${code}）`);
            botProc = null;
        });
        resolve({ ok: true, msg: 'AI 机器人启动中，登录游戏约需 10 秒。' });
    });
}

function stopBot() {
    return new Promise((resolve) => {
        if (!botProc) return resolve({ ok: false, msg: '机器人没有由本面板启动。' });
        const pid = botProc.pid;
        emitLog('panel', '正在停止机器人…');
        try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }); } catch {}
        const t = setTimeout(() => { botProc = null; resolve({ ok: true, msg: '已强制结束机器人进程。' }); }, 6000);
        botProc.once('exit', () => { clearTimeout(t); botProc = null; resolve({ ok: true, msg: '机器人已停止。' }); });
    });
}

function say(text, from = 'Player') {
    return new Promise((resolve) => {
        const script = path.join(cfg.mindcraftDir, cfg.sayScript);
        if (!fs.existsSync(script)) return resolve({ ok: false, msg: `找不到 ${cfg.sayScript}` });
        const p = spawn(cfg.nodePath, [cfg.sayScript, from, String(text)], { cwd: cfg.mindcraftDir, windowsHide: true });
        let out = '';
        p.stdout.setEncoding('utf8');
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.setEncoding('utf8');
        p.stderr.on('data', (d) => { out += d; });
        p.on('exit', (code) => {
            emitLog('panel', `[派活] ${from} → ${text}`);
            resolve({ ok: code === 0, msg: code === 0 ? '已发送，等它回应。' : `发送失败：${out.slice(0, 300)}` });
        });
    });
}

// ---------------------------------------------------------------- 窗口
function createWindow() {
    win = new BrowserWindow({
        width: 1180,
        height: 760,
        minWidth: 900,
        minHeight: 600,
        backgroundColor: '#141414',
        title: 'Minecraft AI 控制面板',
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    win.on('closed', () => { win = null; });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

    app.whenReady().then(async () => {
        cfg = loadConfig();
        if (!fs.existsSync(configPath())) saveConfig(cfg);

        ipcMain.handle('cfg:get', () => cfg);
        ipcMain.handle('cfg:set', (_e, next) => {
            cfg = { ...cfg, ...next };
            const saved = saveConfig(cfg);
            startLogTail();
            return { ok: true, msg: '配置已保存：' + saved };
        });
        ipcMain.handle('status', () => getStatus());
        ipcMain.handle('server:start', () => startServer());
        ipcMain.handle('server:stop', () => stopServer());
        ipcMain.handle('bot:start', () => startBot());
        ipcMain.handle('bot:stop', () => stopBot());
        ipcMain.handle('say', (_e, text, from) => say(text, from));
        ipcMain.handle('logs:history', () => ({ logs: logs.slice(-600), chats: chats.slice(-200) }));
        ipcMain.handle('logs:clear', () => { logs.length = 0; chats.length = 0; return { ok: true }; });
        ipcMain.handle('pick:dir', async () => {
            const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
            return r.canceled ? null : r.filePaths[0];
        });
        ipcMain.handle('open:path', async (_e, p) => {
            if (!p) return { ok: false };
            const target = fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : path.dirname(p);
            await shell.openPath(target);
            return { ok: true };
        });

        createWindow();
        startLogTail();
    });

    app.on('window-all-closed', () => {
        stopLogTail();
        app.quit();
    });
}
