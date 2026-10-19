'use strict';
/**
 * Minecraft AI 控制面板 —— 后端服务
 * 用纯 Node 提供 HTTP API + 静态页面，供 Edge 应用窗口 / 浏览器访问。
 * 不用 Electron（本机 Electron 一启动就崩，Chromium 窗口本身是正常的）。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = __dirname;                       // 后端所在目录（= 资源解压目录）
const RENDERER = path.join(ROOT, 'renderer');
const DATA_DIR = process.env.MCAI_DATA_DIR || path.join(ROOT, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DEFAULTS = {
    // 占位默认值：真实路径保存在 data/config.json（不随仓库发布）
    serverDir: 'C:/mc-ai/server',
    mindcraftDir: 'C:/mc-ai/mindcraft',
    javaPath: 'java',
    javaArgs: '-Xms1G -Xmx2G',
    serverPort: 25565,
    mindserverPort: 8080,
    botName: 'AIBot',
    sayScript: 'say.mjs',
    nodePath: process.execPath,
};

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadConfig() {
    try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; }
    catch { return { ...DEFAULTS }; }
}
function saveConfig(cfg) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

let cfg = loadConfig();
if (!fs.existsSync(CONFIG_FILE)) saveConfig(cfg);

// ------------------------------------------------------------------ 运行状态
const LOG_LIMIT = 2000;
const logs = [];              // {t, src, line}
const chats = [];             // {t, from, text}
const players = new Map();
let seq = 0;                  // 单调递增序号，前端按 since 拉增量
let lastBeat = Date.now();    // 前端心跳，用于窗口关掉后自动退出后端

let serverProc = null;
let serverOwned = false;
let botProc = null;

function pushLog(src, line) {
    const text = String(line == null ? '' : line).replace(/\r$/, '');
    if (!text.trim()) return;
    const entry = { i: ++seq, t: Date.now(), src, line: text };
    logs.push(entry);
    if (logs.length > LOG_LIMIT) logs.shift();

    const m = text.match(/<([^>]{1,32})>\s(.*)$/);
    if (m) {
        const c = { i: ++seq, t: entry.t, from: m[1], text: m[2] };
        chats.push(c);
        if (chats.length > 500) chats.shift();
    }
    const j = text.match(/([A-Za-z0-9_]{1,16}) joined the game/);
    const l = text.match(/([A-Za-z0-9_]{1,16}) left the game/);
    if (j) players.set(j[1], Date.now());
    if (l) players.delete(l[1]);
}

// ------------------------------------------------------------------ 解码
// Windows 中文环境下 java 的 stdout 与 latest.log 常是 GBK（cp936），
// 直接按 UTF-8 解会得到 "锛?/锟?" 这类乱码。这里先严格试 UTF-8，失败再回退 GBK。
const DECODERS = { utf8: () => new TextDecoder('utf-8'), gbk: () => new TextDecoder('gbk') };

function sniffEncoding(buf) {
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(buf);
        return 'utf8';
    } catch { return 'gbk'; }
}

function pipeLines(stream, src, enc, only) {
    const decoder = DECODERS[enc || 'utf8']();
    let buf = '';
    const emit = (line) => {
        if (!line || (only && !only.test(line))) return;
        pushLog(src, line);
    };
    stream.on('data', (chunk) => {
        buf += decoder.decode(chunk, { stream: true });
        const parts = buf.split('\n');
        buf = parts.pop();
        for (const p of parts) emit(p);
    });
    stream.on('end', () => {
        buf += decoder.decode();
        if (buf) emit(buf);
    });
}

// 跟随服务端 latest.log（外部启动的服务器也能看到聊天）
let logTimer = null;
let tail = { offset: 0, decoder: null, rest: '' };
const LOG_KEEP = /joined the game|left the game|<[^>]+>\s|Done \(|Starting minecraft server|Thrown|Exception/;

function startLogTail() {
    if (logTimer) clearInterval(logTimer);
    tail = { offset: 0, decoder: null, rest: '' };
    logTimer = setInterval(() => {
        const file = path.join(cfg.serverDir, 'logs', 'latest.log');
        let st;
        try { st = fs.statSync(file); } catch { return; }
        if (st.size < tail.offset) tail = { offset: 0, decoder: null, rest: '' };
        if (st.size === tail.offset) return;
        try {
            const fd = fs.openSync(file, 'r');
            const len = Math.min(st.size - tail.offset, 512 * 1024);
            const buf = Buffer.alloc(len);
            const n = fs.readSync(fd, buf, 0, len, tail.offset);
            fs.closeSync(fd);
            tail.offset += n;
            if (!tail.decoder) tail.decoder = DECODERS[sniffEncoding(buf.subarray(0, Math.min(n, 8192)))]();
            tail.rest += tail.decoder.decode(buf.subarray(0, n), { stream: true });
            const lines = tail.rest.split('\n');
            tail.rest = lines.pop();
            for (const raw of lines) {
                if (!raw) continue;
                if (LOG_KEEP.test(raw)) pushLog('server', raw.replace(/^\[[^\]]*\]\s*(?:\[[^\]]*\]\s*)?:?\s*/, ''));
            }
        } catch { /* 文件被占用，跳过 */ }
    }, 900);
}

// ------------------------------------------------------------------ 工具
function probePort(port, host = '127.0.0.1') {
    return new Promise((resolve) => {
        const s = new net.Socket();
        const done = (ok) => { s.destroy(); resolve(ok); };
        s.setTimeout(800);
        s.once('connect', () => done(true));
        s.once('timeout', () => done(false));
        s.once('error', () => done(false));
        s.connect(port, host);
    });
}

async function portOpen(port) {
    if (await probePort(port, '127.0.0.1')) return true;
    return await probePort(port, '::1');   // MindServer 在 Windows 上常只绑 IPv6
}

async function getStatus() {
    const [serverUp, mindUp] = await Promise.all([portOpen(cfg.serverPort), portOpen(cfg.mindserverPort)]);
    return {
        server: { up: serverUp, owned: serverOwned && !!serverProc, pid: serverProc ? serverProc.pid : null, port: cfg.serverPort },
        bot: { up: mindUp, running: !!botProc, pid: botProc ? botProc.pid : null, name: cfg.botName },
        players: [...players.keys()],
        paths: {
            serverDir: cfg.serverDir,
            mindcraftDir: cfg.mindcraftDir,
            serverDirOk: fs.existsSync(path.join(cfg.serverDir, 'server.jar')),
            mindcraftDirOk: fs.existsSync(path.join(cfg.mindcraftDir, 'main.js')),
            javaOk: fs.existsSync(cfg.javaPath),
        },
        configFile: CONFIG_FILE,
    };
}

async function startServer() {
    if (await portOpen(cfg.serverPort)) {
        serverOwned = false;
        startLogTail();
        return { ok: true, msg: '检测到端口已在监听（外部启动的服务器），已接管日志监听。' };
    }
    const jar = path.join(cfg.serverDir, 'server.jar');
    if (!fs.existsSync(jar)) return { ok: false, msg: '找不到服务端：' + jar };
    const args = [...String(cfg.javaArgs).split(/\s+/).filter(Boolean), '-jar', 'server.jar', 'nogui'];
    pushLog('panel', '启动服务器：' + cfg.javaPath + ' ' + args.join(' '));
    let p;
    try {
        p = spawn(cfg.javaPath, args, { cwd: cfg.serverDir, windowsHide: true });
    } catch (e) {
        return { ok: false, msg: '启动失败：' + e.message };
    }
    serverProc = p;
    serverOwned = true;
    // stdout 是 GBK；正常日志统一走 latest.log（带解码嗅探），这里只捞异常行，避免重复与乱码
    pipeLines(p.stdout, 'server', 'gbk', /Exception|ERROR\]|Failed to|Could not|Address already in use/);
    pipeLines(p.stderr, 'server', 'gbk', null);
    p.on('exit', (code) => {
        pushLog('panel', '服务器进程已退出（code=' + code + '）');
        serverProc = null; serverOwned = false;
    });
    startLogTail();
    return { ok: true, msg: '服务器启动中，约 10~30 秒后可连接。' };
}

function stopServer() {
    return new Promise((resolve) => {
        if (!serverProc || !serverOwned) {
            return resolve({ ok: false, msg: '服务器不是本面板启动的，无法从面板关闭（请在控制台输入 stop）。' });
        }
        pushLog('panel', '正在停止服务器（发送 stop）…');
        try { serverProc.stdin.write('stop\n'); } catch {}
        const timer = setTimeout(() => {
            if (serverProc) { try { spawn('taskkill', ['/pid', String(serverProc.pid), '/T', '/F'], { windowsHide: true }); } catch {} }
        }, 15000);
        serverProc.once('exit', () => { clearTimeout(timer); resolve({ ok: true, msg: '服务器已停止。' }); });
    });
}

async function startBot() {
    if (botProc) return { ok: false, msg: '机器人已在运行。' };
    if (await portOpen(cfg.mindserverPort)) return { ok: false, msg: '8080 已被占用（MindServer 已在跑）。' };
    const main = path.join(cfg.mindcraftDir, 'main.js');
    if (!fs.existsSync(main)) return { ok: false, msg: '找不到 main.js：' + main };
    pushLog('panel', '启动 AI 机器人…');
    let p;
    try {
        p = spawn(cfg.nodePath, ['main.js'], { cwd: cfg.mindcraftDir, windowsHide: true });
    } catch (e) {
        return { ok: false, msg: '启动失败：' + e.message };
    }
    botProc = p;
    pipeLines(p.stdout, 'bot');
    pipeLines(p.stderr, 'bot');
    p.on('exit', (code) => {
        pushLog('panel', '机器人进程已退出（code=' + code + '）');
        botProc = null;
    });
    return { ok: true, msg: 'AI 机器人启动中，登录游戏约 10 秒。' };
}

function stopBot() {
    return new Promise((resolve) => {
        if (!botProc) return resolve({ ok: false, msg: '机器人不是本面板启动的。' });
        const pid = botProc.pid;
        pushLog('panel', '正在停止机器人…');
        try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }); } catch {}
        const timer = setTimeout(() => { botProc = null; resolve({ ok: true, msg: '已强制结束。' }); }, 6000);
        botProc.once('exit', () => { clearTimeout(timer); botProc = null; resolve({ ok: true, msg: '机器人已停止。' }); });
    });
}

function say(text) {
    return new Promise((resolve) => {
        const scriptName = cfg.sayScript || 'say.mjs';
        if (!fs.existsSync(path.join(cfg.mindcraftDir, scriptName))) {
            return resolve({ ok: false, msg: '找不到 ' + scriptName });
        }
        const p = spawn(cfg.nodePath, [scriptName, 'Player', String(text)], { cwd: cfg.mindcraftDir, windowsHide: true });
        let out = '';
        p.stdout.setEncoding('utf8'); p.stdout.on('data', (d) => { out += d; });
        p.stderr.setEncoding('utf8'); p.stderr.on('data', (d) => { out += d; });
        p.on('exit', (code) => {
            pushLog('panel', '[派活] Player → ' + text);
            resolve({ ok: code === 0, msg: code === 0 ? '已发送，等它回应。' : '发送失败：' + out.slice(0, 300) });
        });
    });
}

// ------------------------------------------------------------------ HTTP
function json(res, code, body) {
    const data = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
}

function readBody(req) {
    return new Promise((resolve) => {
        let raw = '';
        req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
        req.on('end', () => {
            try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
        });
    });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon' };

function serveStatic(res, urlPath) {
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const file = path.join(RENDERER, rel);
    if (!file.startsWith(RENDERER)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
    });
}

const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const p = u.pathname;

    try {
        if (!p.startsWith('/api/')) return serveStatic(res, p);

        if (p === '/api/cfg' && req.method === 'GET') return json(res, 200, cfg);
        if (p === '/api/cfg' && req.method === 'POST') {
            const body = await readBody(req);
            cfg = { ...cfg, ...body };
            saveConfig(cfg);
            startLogTail();
            return json(res, 200, { ok: true, msg: '配置已保存：' + CONFIG_FILE });
        }
        if (p === '/api/status') return json(res, 200, await getStatus());
        if (p === '/api/server/start') return json(res, 200, await startServer());
        if (p === '/api/server/stop') return json(res, 200, await stopServer());
        if (p === '/api/bot/start') return json(res, 200, await startBot());
        if (p === '/api/bot/stop') return json(res, 200, await stopBot());
        if (p === '/api/say' && req.method === 'POST') {
            const body = await readBody(req);
            return json(res, 200, await say(body.text || ''));
        }
        if (p === '/api/history') return json(res, 200, { logs: logs.slice(-600), chats: chats.slice(-200), next: seq });
        if (p === '/api/logs') {
            const since = Number(u.searchParams.get('since') || 0);
            return json(res, 200, {
                logs: logs.filter((e) => e.i > since).slice(0, 400),
                chats: chats.filter((e) => e.i > since).slice(0, 200),
                next: seq,
            });
        }
        if (p === '/api/logs/clear') { logs.length = 0; chats.length = 0; return json(res, 200, { ok: true }); }
        if (p === '/api/beat') { lastBeat = Date.now(); return json(res, 200, { ok: true }); }
        if (p === '/api/open' && req.method === 'POST') {
            const body = await readBody(req);
            const target = body.path;
            if (!target) return json(res, 200, { ok: false, msg: '路径为空' });
            const dir = fs.existsSync(target) && fs.statSync(target).isDirectory() ? target : path.dirname(target);
            spawn('explorer.exe', [dir], { detached: true, windowsHide: true }).unref();
            return json(res, 200, { ok: true, msg: '已打开：' + dir });
        }
        json(res, 404, { ok: false, msg: '未知接口 ' + p });
    } catch (e) {
        json(res, 500, { ok: false, msg: String(e && e.stack || e) });
    }
});

const WANTED = Number(process.argv[2]) || 4599;
function listen(port, tries = 12) {
    server.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && tries > 0) { listen(port + 1, tries - 1); }
        else { console.error('监听失败:', e.message); process.exit(1); }
    });
    server.listen(port, '127.0.0.1', () => {
        startLogTail();
        pushLog('panel', '控制面板后端已启动，端口 ' + port);
        // 用一行固定格式告知启动器真实端口
        console.log('MCAI_READY ' + port);
        // 窗口关掉后（心跳停止）自动退出，别留后台僵尸
        setInterval(() => {
            if (Date.now() - lastBeat > 60000) {
                pushLog('panel', '前端已断开，后端退出');
                process.exit(0);
            }
        }, 5000);
    });
}
listen(WANTED);

// 退出时别把子进程拖死：让 java / bot 继续跑
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
