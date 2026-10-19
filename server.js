'use strict';
/**
 * Minecraft AI 控制面板 —— 后端服务
 * 纯 Node 提供 HTTP API + 静态页面，供 Edge 应用窗口 / 浏览器访问。
 *
 * 多开机器人的原理：MindServer(8080) 支持 socket 事件
 *   create-agent / start-agent / stop-agent / destroy-agent / send-message
 * 所以面板只跑「一个」MindServer 进程，机器人按需动态创建，互不影响。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { createRequire } = require('module');

const ROOT = __dirname;
const RENDERER = path.join(ROOT, 'renderer');
const DATA_DIR = process.env.MCAI_DATA_DIR || path.join(ROOT, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const BOTS_FILE = path.join(DATA_DIR, 'bots.json');

const DEFAULTS = {
    // 占位默认值：真实路径保存在 data/config.json（不随仓库发布）
    serverDir: 'C:/mc-ai/server',
    mindcraftDir: 'C:/mc-ai/mindcraft',
    javaPath: 'java',
    javaArgs: '-Xms1G -Xmx2G',
    serverPort: 25565,
    mindserverPort: 8080,
    mcVersion: '1.20.1',
    sayScript: 'say.mjs',
    nodePath: process.execPath,
};

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadConfig() {
    try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; }
    catch { return { ...DEFAULTS }; }
}
function saveConfig(cfg) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8'); }

let cfg = loadConfig();
if (!fs.existsSync(CONFIG_FILE)) saveConfig(cfg);

// ------------------------------------------------------------------ 机器人定义
// 每个机器人 = 一份 mindcraft profile（名字 / 模型 / 接口），持久化在 data/bots.json
function defaultBots() {
    const seed = {
        name: 'AIBot',
        model: 'cline-pass/deepseek-v4.1-flash',
        api: 'deepseek',
        url: 'https://api.cline.bot/api/v1',
        language: 'zh',
        initMessage: '',
        enabled: true,
    };
    // 首次运行：尽量沿用 mindcraft/profiles/cline.json 里已有的配置
    try {
        const p = JSON.parse(fs.readFileSync(path.join(cfg.mindcraftDir, 'profiles', 'cline.json'), 'utf8'));
        if (p.name) Object.assign(seed, { name: p.name, model: p.model || seed.model, api: p.api || seed.api, url: p.url || seed.url });
    } catch { /* 没有就算了 */ }
    return [seed];
}

function loadBots() {
    try {
        const list = JSON.parse(fs.readFileSync(BOTS_FILE, 'utf8'));
        if (Array.isArray(list)) return list;
    } catch { /* 走默认 */ }
    const list = defaultBots();
    saveBots(list);
    return list;
}
function saveBots(list) { fs.writeFileSync(BOTS_FILE, JSON.stringify(list, null, 2), 'utf8'); }

let bots = loadBots();

const BOT_NAME_RE = /^[A-Za-z0-9_]{3,16}$/;

function botSettings(bot) {
    return {
        profile: { name: bot.name, model: bot.model, api: bot.api, url: bot.url },
        host: '127.0.0.1',
        port: cfg.serverPort,
        minecraft_version: cfg.mcVersion || '1.20.1',
        auth: 'offline',
        base_profile: 'survival',
        init_message: bot.initMessage || '',
        // 固定 en：非 en 会让 mindcraft 调 google-translate-api-x 把发言翻译一遍，
        // 国内基本连不上（报 "language zh unsupported / 网络失败"），而且机器人本来就跟着你的语言回答。
        language: 'en',
        load_memory: false,
    };
}

// ------------------------------------------------------------------ 运行状态
const LOG_LIMIT = 2000;
const logs = [];
const chats = [];
const players = new Map();
let seq = 0;
let lastBeat = Date.now();

let serverProc = null;
let serverOwned = false;
let mindProc = null;          // MindServer（main.js）进程
let agentsCache = [];         // 来自 MindServer 的 agents-status

function pushLog(src, line, when) {
    const text = String(line == null ? '' : line).replace(/\r$/, '');
    if (!text.trim()) return;
    const entry = { i: ++seq, t: when || Date.now(), src, line: text };
    logs.push(entry);
    if (logs.length > LOG_LIMIT) logs.shift();

    const m = text.match(/^<([^>]{1,32})>\s(.*)$/);
    if (m) {
        const c = { i: ++seq, t: entry.t, from: m[1], text: m[2] };
        chats.push(c);
        if (chats.length > 800) chats.shift();
    }
    const j = text.match(/([A-Za-z0-9_]{1,16}) joined the game/);
    const l = text.match(/([A-Za-z0-9_]{1,16}) left the game/);
    if (j) players.set(j[1], Date.now());
    if (l) players.delete(l[1]);
}

// ------------------------------------------------------------------ 解码
// Windows 中文环境下 java 的 stdout 与 latest.log 常是 GBK（cp936），
// 按 UTF-8 硬解会得到 "锛?/锟?" 这类乱码。先严格试 UTF-8，失败回退 GBK。
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

// 跟随一个正在增长的文件：带编码嗅探的流式解码，按需过滤
const followers = new Map();

function followFile(key, filePath, src, keepRe) {
    const old = followers.get(key);
    if (old) clearInterval(old.timer);
    const st = { offset: 0, decoder: null, rest: '' };
    const timer = setInterval(() => {
        let stat;
        try { stat = fs.statSync(filePath); } catch { return; }
        if (stat.size < st.offset) { st.offset = 0; st.decoder = null; st.rest = ''; }
        if (stat.size === st.offset) return;
        try {
            const fd = fs.openSync(filePath, 'r');
            const len = Math.min(stat.size - st.offset, 512 * 1024);
            const buf = Buffer.alloc(len);
            const n = fs.readSync(fd, buf, 0, len, st.offset);
            fs.closeSync(fd);
            st.offset += n;
            if (!st.decoder) st.decoder = DECODERS[sniffEncoding(buf.subarray(0, Math.min(n, 8192)))]();
            st.rest += st.decoder.decode(buf.subarray(0, n), { stream: true });
            const lines = st.rest.split('\n');
            st.rest = lines.pop();
            for (const raw of lines) {
                if (!raw) continue;
                if (keepRe && !keepRe.test(raw)) continue;
                let when;
                const tm = raw.match(/^\[(\d{2}):(\d{2}):(\d{2})\]/);
                if (tm) {
                    const d = new Date();
                    d.setHours(+tm[1], +tm[2], +tm[3], 0);
                    when = d.getTime();
                }
                const clean = raw
                    .replace(/^\[[^\]]*\]\s*(?:\[[^\]]*\]\s*)?:?\s*/, '')
                    .replace(/^\[Not Secure\]\s*/, '');
                pushLog(src, clean, when);
            }
        } catch { /* 文件被占用，跳过 */ }
    }, 900);
    followers.set(key, { timer, st });
}

// 跟随服务端 latest.log（外部启动的服务器也能看到聊天）
const LOG_KEEP = /joined the game|left the game|<[^>]+>\s|Done \(|Starting minecraft server|Thrown|Exception/;

function startLogTail() {
    followFile('server', path.join(cfg.serverDir, 'logs', 'latest.log'), 'server', LOG_KEEP);
}

// 机器人的输出（MindServer 进程与各 agent 子进程的 stdout）
function startMindTail() {
    followFile('mind', path.join(DATA_DIR, 'mindserver.log'), 'bot', null);
}

// ------------------------------------------------------------------ 端口 / 进程
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

// ------------------------------------------------------------------ MindServer 客户端
let mindReq = null;
let mSock = null;
let mSockTried = false;
let lastMindError = '';

function mindRequire() {
    if (!mindReq) mindReq = createRequire(path.join(cfg.mindcraftDir, 'package.json'));
    return mindReq;
}

// MindServer 监听 'localhost'，在 Windows 上会解析到 IPv6(::1)，因此这里也用 localhost 连
function mindUrl() { return 'http://localhost:' + cfg.mindserverPort; }

function ensureMind() {
    return new Promise((resolve) => {
        const { io } = mindRequire()('socket.io-client');
        if (mSock && mSock.connected) return resolve(mSock);
        if (!mSock) {
            mSock = io(mindUrl(), {
                transports: ['websocket'],
                reconnection: true,
                reconnectionDelay: 800,
                timeout: 4000,
            });
            mSock.on('agents-status', (list) => { agentsCache = Array.isArray(list) ? list : []; });
            mSock.on('connect', () => { lastMindError = ''; });
            mSock.on('connect_error', (e) => { lastMindError = String(e && e.message || e); });
        }
        let waited = 0;
        const tick = setInterval(() => {
            if (mSock && mSock.connected) { clearInterval(tick); resolve(mSock); }
            else if ((waited += 200) >= 5000) { clearInterval(tick); resolve(null); }
        }, 200);
        mSockTried = true;
    });
}

function emitAsync(event, payload) {
    return new Promise((resolve) => {
        if (!mSock || !mSock.connected) return resolve({ success: false, error: 'MindServer 未连接' });
        let done = false;
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            resolve({ success: false, error: '等待 MindServer 回应超时' });
        }, 25000);
        mSock.emit(event, payload, (res) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(res || {});
        });
    });
}

function waitAgents(name, timeoutMs) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        const tick = setInterval(() => {
            const a = agentsCache.find((x) => x.name === name);
            if (a || Date.now() - t0 > timeoutMs) { clearInterval(tick); resolve(a || null); }
        }, 300);
    });
}

// ------------------------------------------------------------------ 机器人动作
async function startBotOne(name) {
    const bot = bots.find((b) => b.name === name);
    if (!bot) return { ok: false, msg: '没有这个机器人：' + name };

    if (!(await portOpen(cfg.mindserverPort))) {
        return { ok: false, msg: 'MindServer 还没起，请先点「启动 MindServer」。' };
    }
    await ensureMind();
    if (!mSock || !mSock.connected) {
        return { ok: false, msg: '连不上 MindServer：' + (lastMindError || '原因未知') };
    }

    const exist = agentsCache.find((a) => a.name === name);
    if (exist) {
        mSock.emit('start-agent', name);           // 已注册但进程被停过 → 重新拉起
        pushLog('panel', '重启机器人 ' + name);
        return { ok: true, msg: name + ' 启动中…' };
    }

    const res = await emitAsync('create-agent', botSettings(bot));
    if (res && res.success === false) return { ok: false, msg: name + ' 创建失败：' + (res.error || '未知原因') };
    pushLog('panel', '创建机器人 ' + name + '（' + bot.model + '）');
    return { ok: true, msg: name + ' 正在进服…' };
}

async function stopBotOne(name) {
    if (!mSock || !mSock.connected) return { ok: false, msg: 'MindServer 未连接。' };
    mSock.emit('stop-agent', name);
    pushLog('panel', '停止机器人 ' + name);
    return { ok: true, msg: name + ' 已停止。' };
}

async function destroyBotOne(name) {
    if (mSock && mSock.connected) mSock.emit('destroy-agent', name);
    return { ok: true };
}

async function startBot() {
    // 1) 确保 MindServer 在跑（只跑服务，不自动创建任何机器人）
    if (!(await portOpen(cfg.mindserverPort))) {
        const main = path.join(cfg.mindcraftDir, 'main.js');
        if (!fs.existsSync(main)) return { ok: false, msg: '找不到 main.js：' + main };
        pushLog('panel', '启动 MindServer（不自动建 bot）…');
        // 输出写文件而不是管道：这样面板关掉、管道断开也不会把 MindServer 带走
        const mindLog = fs.openSync(path.join(DATA_DIR, 'mindserver.log'), 'a');
        const p = spawn(cfg.nodePath, ['main.js'], {
            cwd: cfg.mindcraftDir,
            windowsHide: true,
            stdio: ['ignore', mindLog, mindLog],
            env: { ...process.env, SETTINGS_JSON: JSON.stringify({ profiles: [] }) },
        });
        fs.closeSync(mindLog);
        mindProc = p;
        startMindTail();
        p.on('exit', (code) => {
            pushLog('panel', 'MindServer 已退出（code=' + code + '）');
            mindProc = null;
            agentsCache = [];
        });
        // 等端口起来
        const t0 = Date.now();
        while (Date.now() - t0 < 25000) {
            if (await portOpen(cfg.mindserverPort)) break;
            await new Promise((r) => setTimeout(r, 500));
        }
        if (!(await portOpen(cfg.mindserverPort))) return { ok: false, msg: 'MindServer 启动失败（端口无响应）。' };
    }
    await ensureMind();

    // 2) 逐个创建「已启用」的机器人
    const targets = bots.filter((b) => b.enabled !== false);
    if (!targets.length) return { ok: true, msg: 'MindServer 已就绪，但没有启用的机器人。' };

    const results = [];
    for (const bot of targets) {
        const r = await startBotOne(bot.name);
        results.push(bot.name + (r.ok ? ' ✓' : ' ✗'));
        await new Promise((res) => setTimeout(res, 1200));   // 错开进服，避免同时抢名
    }
    return { ok: true, msg: '已提交：' + results.join('、') };
}

async function stopBot() {
    let n = 0;
    if (mSock && mSock.connected) {
        mSock.emit('stop-all-agents');
        n = agentsCache.length;
    }
    pushLog('panel', '停止全部机器人（' + n + '）');
    return { ok: true, msg: n ? '已停止 ' + n + ' 个机器人。' : '没有在跑的机器人。' };
}

async function shutdownMind() {
    if (!await portOpen(cfg.mindserverPort)) return { ok: true, msg: 'MindServer 本来就没在跑。' };
    await ensureMind();
    if (mSock && mSock.connected) mSock.emit('shutdown');
    await new Promise((r) => setTimeout(r, 1200));
    if (mindProc) { try { mindProc.kill(); } catch { } mindProc = null; }
    agentsCache = [];
    pushLog('panel', 'MindServer 已关闭');
    return { ok: true, msg: 'MindServer 已关闭。' };
}

async function say(text, to) {
    if (!mSock || !mSock.connected) await ensureMind();
    if (!mSock || !mSock.connected) return { ok: false, msg: '连不上 MindServer（机器人服务没起？）' };

    const inGame = agentsCache.filter((a) => a.in_game).map((a) => a.name);
    let targets;
    if (!to || to === '__all__') targets = inGame;
    else targets = inGame.filter((n) => n === to);

    if (!targets.length) return { ok: false, msg: '没有在游戏里的机器人可派活。' };

    for (const name of targets) mSock.emit('send-message', name, { from: 'Player', message: text });
    pushLog('panel', '[派活] Player → ' + targets.join('、') + '：' + text);
    return { ok: true, msg: '已发给 ' + targets.join('、') + '，等它回应。' };
}

// ------------------------------------------------------------------ 服务端
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
        try { serverProc.stdin.write('stop\n'); } catch { }
        const timer = setTimeout(() => {
            if (serverProc) { try { spawn('taskkill', ['/pid', String(serverProc.pid), '/T', '/F'], { windowsHide: true }); } catch { } }
        }, 15000);
        serverProc.once('exit', () => { clearTimeout(timer); resolve({ ok: true, msg: '服务器已停止。' }); });
    });
}

// ------------------------------------------------------------------ 状态汇总
function botStateOf(name) {
    const a = agentsCache.find((x) => x.name === name);
    if (!a) return 'notcreated';
    if (a.in_game) return 'online';
    if (a.socket_connected) return 'starting';
    return 'offline';
}

async function getStatus() {
    const [serverUp, mindUp] = await Promise.all([portOpen(cfg.serverPort), portOpen(cfg.mindserverPort)]);
    if (mindUp && (!mSock || !mSock.connected)) {
        // MindServer 起来了但客户端还没连上 → 顺手连一次，拿到 agents-status
        ensureMind();
    }
    if (!mindUp) agentsCache = [];

    return {
        server: { up: serverUp, owned: serverOwned && !!serverProc, pid: serverProc ? serverProc.pid : null, port: cfg.serverPort },
        bot: {
            up: mindUp,
            running: !!mindProc,
            pid: mindProc ? mindProc.pid : null,
            port: cfg.mindserverPort,
            agents: agentsCache,
        },
        bots: bots.map((b) => ({
            name: b.name,
            model: b.model,
            api: b.api,
            url: b.url,
            language: b.language || 'zh',
            initMessage: b.initMessage || '',
            enabled: b.enabled !== false,
            state: botStateOf(b.name),
            inGame: !!agentsCache.find((a) => a.name === b.name && a.in_game),
        })),
        players: [...players.keys()],
        paths: {
            serverDir: cfg.serverDir,
            mindcraftDir: cfg.mindcraftDir,
            serverDirOk: fs.existsSync(path.join(cfg.serverDir, 'server.jar')),
            mindcraftDirOk: fs.existsSync(path.join(cfg.mindcraftDir, 'main.js')),
            javaOk: fs.existsSync(cfg.javaPath),
        },
        configFile: CONFIG_FILE,
        botsFile: BOTS_FILE,
    };
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

        // ---- 服务器
        if (p === '/api/server/start') return json(res, 200, await startServer());
        if (p === '/api/server/stop') return json(res, 200, await stopServer());

        // ---- 机器人（多开）
        if (p === '/api/bots' && req.method === 'GET') return json(res, 200, { bots: (await getStatus()).bots });

        if (p === '/api/bots' && req.method === 'POST') {
            const body = await readBody(req);
            const name = String(body.name || '').trim();
            if (!BOT_NAME_RE.test(name)) return json(res, 200, { ok: false, msg: '名字只能用 3~16 位字母/数字/下划线。' });
            if (!body.model) return json(res, 200, { ok: false, msg: '模型不能为空。' });
            if (!body.url) return json(res, 200, { ok: false, msg: '接口地址不能为空。' });

            const def = {
                name,
                model: String(body.model).trim(),
                api: String(body.api || 'deepseek').trim(),
                url: String(body.url).trim(),
                language: String(body.language || 'zh').trim(),
                initMessage: String(body.initMessage || '').trim(),
                enabled: body.enabled !== false,
            };
            const idx = bots.findIndex((b) => b.name === name);
            if (idx >= 0) bots[idx] = { ...bots[idx], ...def };
            else bots.push(def);
            saveBots(bots);
            return json(res, 200, { ok: true, msg: (idx >= 0 ? '已更新 ' : '已添加 ') + name });
        }

        if (p === '/api/bots/delete' && req.method === 'POST') {
            const body = await readBody(req);
            const name = String(body.name || '');
            await destroyBotOne(name);
            bots = bots.filter((b) => b.name !== name);
            saveBots(bots);
            return json(res, 200, { ok: true, msg: '已删除 ' + name });
        }

        if (p === '/api/bots/toggle' && req.method === 'POST') {
            const body = await readBody(req);
            const bot = bots.find((b) => b.name === body.name);
            if (!bot) return json(res, 200, { ok: false, msg: '没有这个机器人' });
            bot.enabled = !!body.enabled;
            saveBots(bots);
            return json(res, 200, { ok: true, msg: bot.name + (bot.enabled ? ' 已启用' : ' 已禁用') });
        }

        if (p === '/api/bots/start' && req.method === 'POST') {
            const body = await readBody(req);
            return json(res, 200, await startBotOne(String(body.name || '')));
        }
        if (p === '/api/bots/stop' && req.method === 'POST') {
            const body = await readBody(req);
            return json(res, 200, await stopBotOne(String(body.name || '')));
        }

        // ---- 全部机器人（兼容旧接口）
        if (p === '/api/bot/start') return json(res, 200, await startBot());
        if (p === '/api/bot/stop') return json(res, 200, await stopBot());
        if (p === '/api/bot/shutdown') return json(res, 200, await shutdownMind());

        if (p === '/api/say' && req.method === 'POST') {
            const body = await readBody(req);
            return json(res, 200, await say(body.text || '', body.to));
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
        if (fs.existsSync(path.join(DATA_DIR, 'mindserver.log'))) startMindTail();   // 面板重开时继续跟
        pushLog('panel', '控制面板后端已启动，端口 ' + port);
        console.log('MCAI_READY ' + port);
        setInterval(() => {
            if (Date.now() - lastBeat > 60000) {
                pushLog('panel', '前端已断开，后端退出');
                process.exit(0);
            }
        }, 5000);
    });
}
listen(WANTED);

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
