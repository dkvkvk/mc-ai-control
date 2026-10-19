'use strict';
/* 渲染进程：视图切换 / 状态轮询 / 日志与对话渲染 / 操作绑定
   与后端通过 HTTP 通信（Edge 应用窗口或普通浏览器都能用） */

const $ = (id) => document.getElementById(id);

async function req(method, url, body) {
    const opt = { method, headers: {} };
    if (body !== undefined) {
        opt.headers['Content-Type'] = 'application/json';
        opt.body = JSON.stringify(body);
    }
    const r = await fetch(url, opt);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
}
const get = (u) => req('GET', u);
const post = (u, b) => req('POST', u, b);

const api = {
    getConfig: () => get('/api/cfg'),
    setConfig: (c) => post('/api/cfg', c),
    status: () => get('/api/status'),
    startServer: () => post('/api/server/start'),
    stopServer: () => post('/api/server/stop'),
    startBot: () => post('/api/bot/start'),
    stopBot: () => post('/api/bot/stop'),
    say: (text) => post('/api/say', { text }),
    history: () => get('/api/history'),
    clearLogs: () => post('/api/logs/clear'),
    openPath: (p) => post('/api/open', { path: p }),
};

const state = {
    cfg: null,
    status: null,
    logs: [],
    chats: [],
    filter: 'all',
    view: 'overview',
    since: 0,
};

const VIEW_TITLE = { overview: '概览', server: '服务器', bot: 'AI 机器人', logs: '日志', settings: '设置' };

// ------------------------------------------------------------------ 提示条
function toast(msg, kind) {
    const wrap = $('toasts');
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => el.remove(), 4200);
}

// ------------------------------------------------------------------ 视图
function switchView(name) {
    state.view = name;
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('is-active', b.dataset.view === name));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('is-active', v.id === 'view-' + name));
    $('view-title').textContent = VIEW_TITLE[name] || name;
    if (name === 'logs') renderFullLog();
    if (name === 'bot') renderChats();
}
$('nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-item');
    if (btn) switchView(btn.dataset.view);
});

// ------------------------------------------------------------------ 日志渲染
const pad2 = (n) => String(n).padStart(2, '0');
function timeStr(t) {
    const d = new Date(t);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}
const SRC_LABEL = { server: '服', bot: '机', panel: '面' };

function makeLogLine(entry) {
    const div = document.createElement('span');
    div.className = 'log-line log-' + entry.src;
    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = timeStr(entry.t);
    const src = document.createElement('span');
    src.className = 'log-src';
    src.textContent = '[' + (SRC_LABEL[entry.src] || entry.src) + ']';
    div.appendChild(time);
    div.appendChild(src);
    div.appendChild(document.createTextNode(entry.line));
    return div;
}

function appendToBox(box, entry, max) {
    if (!box) return;
    const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    box.appendChild(makeLogLine(entry));
    while (box.children.length > max) box.removeChild(box.firstChild);
    if (stick) box.scrollTop = box.scrollHeight;
}

function onLog(entry) {
    state.logs.push(entry);
    if (state.logs.length > 1500) state.logs.shift();
    appendToBox($('ov-log'), entry, 40);
    if (entry.src === 'server' || entry.src === 'panel') appendToBox($('sv-log'), entry, 150);
    if (state.filter === 'all' || state.filter === entry.src) {
        if (state.view === 'logs') appendToBox($('full-log'), entry, 900);
    }
}

function renderFullLog() {
    const box = $('full-log');
    box.textContent = '';
    const rows = state.logs.filter((e) => state.filter === 'all' || e.src === state.filter).slice(-900);
    for (const e of rows) box.appendChild(makeLogLine(e));
    box.scrollTop = box.scrollHeight;
}

document.querySelectorAll('.chip-btn[data-filter]').forEach((b) => {
    b.addEventListener('click', () => {
        state.filter = b.dataset.filter;
        document.querySelectorAll('.chip-btn[data-filter]').forEach((x) => x.classList.toggle('is-on', x === b));
        renderFullLog();
    });
});

// ------------------------------------------------------------------ 对话
function makeChatRow(c) {
    const row = document.createElement('div');
    row.className = 'chat-row';
    const from = document.createElement('span');
    from.className = 'chat-from' + (c.from && c.from !== 'Player' ? ' is-bot' : '');
    from.textContent = c.from + '：';
    row.appendChild(from);
    row.appendChild(document.createTextNode(c.text));
    return row;
}

function renderChats() {
    const box = $('chat-box');
    box.textContent = '';
    for (const c of state.chats.slice(-200)) box.appendChild(makeChatRow(c));
    box.scrollTop = box.scrollHeight;
}

function onChat(c) {
    state.chats.push(c);
    if (state.chats.length > 400) state.chats.shift();
    if (state.view === 'bot') {
        const box = $('chat-box');
        const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
        box.appendChild(makeChatRow(c));
        while (box.children.length > 200) box.removeChild(box.firstChild);
        if (stick) box.scrollTop = box.scrollHeight;
    }
}

// ------------------------------------------------------------------ 状态
function setDot(el, ok, warn) {
    if (!el) return;
    el.classList.remove('is-on', 'is-off', 'is-warn');
    el.classList.add(ok ? 'is-on' : warn ? 'is-warn' : 'is-off');
}

async function refresh() {
    let s;
    try { s = await api.status(); } catch { return; }
    state.status = s;

    setDot($('dot-server'), s.server.up);
    setDot($('dot-bot'), s.bot.up);
    $('mini-server').textContent = s.server.up ? '运行中' : '已停止';
    $('mini-bot').textContent = s.bot.up ? '在线' : '离线';
    $('mini-players').textContent = s.players.length + ' 人';

    setDot($('c-dot-server'), s.server.up);
    setDot($('c-dot-bot'), s.bot.up);
    $('ov-server-state').textContent = s.server.up ? (s.server.owned ? '运行中（面板启动）' : '运行中（外部启动）') : '已停止';
    $('ov-server-port').textContent = s.server.port;
    $('ov-server-pid').textContent = s.server.pid || '—';
    $('ov-bot-state').textContent = s.bot.up ? '在线' : (s.bot.running ? '启动中…' : '离线');
    $('ov-bot-name').textContent = s.bot.name;
    $('ov-btn-server-start').disabled = s.server.up;
    $('ov-btn-server-stop').disabled = !s.server.owned;
    $('ov-btn-bot-start').disabled = s.bot.up || s.bot.running;
    $('ov-btn-bot-stop').disabled = !s.bot.running;

    const slots = $('player-slots');
    slots.textContent = '';
    if (!s.players.length) {
        const d = document.createElement('div');
        d.className = 'slot slot-empty';
        d.textContent = s.server.up ? '暂无玩家，去 PCL2 里连 127.0.0.1:' + s.server.port : '服务器未运行';
        slots.appendChild(d);
    } else {
        for (const p of s.players) {
            const d = document.createElement('div');
            d.className = 'slot';
            d.textContent = p;
            slots.appendChild(d);
        }
    }

    $('sv-state').textContent = s.server.up ? '运行中' : '已停止';
    $('sv-port').textContent = s.server.port;
    $('sv-java').textContent = state.cfg.javaPath + (s.paths.javaOk ? '' : '（未找到）');
    $('sv-dir').textContent = state.cfg.serverDir;
    $('sv-mem').textContent = state.cfg.javaArgs;
    $('sv-players').textContent = s.players.length;
    $('sv-btn-start').disabled = s.server.up;
    $('sv-btn-stop').disabled = !s.server.owned;

    $('bt-state').textContent = s.bot.up ? '在线（MindServer 已就绪）' : '离线';
    $('bt-name').textContent = s.bot.name;
    $('bt-btn-start').disabled = s.bot.up || s.bot.running;
    $('bt-btn-stop').disabled = !s.bot.running;
    $('chip-port').textContent = ':' + s.server.port;
}

// ------------------------------------------------------------------ 配置
async function loadConfig() {
    state.cfg = await api.getConfig();
    $('cfg-serverDir').value = state.cfg.serverDir;
    $('cfg-mindcraftDir').value = state.cfg.mindcraftDir;
    $('cfg-javaPath').value = state.cfg.javaPath;
    $('cfg-javaArgs').value = state.cfg.javaArgs;
    $('cfg-botName').value = state.cfg.botName;
    $('cfg-serverPort').value = state.cfg.serverPort;
    $('cfg-mindserverPort').value = state.cfg.mindserverPort;
}

document.querySelectorAll('[data-pick]').forEach((b) => {
    b.addEventListener('click', () => {
        toast('这里没有系统文件选择框，直接把完整路径粘贴到输入框即可', 'err');
    });
});

$('cfg-save').addEventListener('click', async () => {
    const next = {
        serverDir: $('cfg-serverDir').value.trim(),
        mindcraftDir: $('cfg-mindcraftDir').value.trim(),
        javaPath: $('cfg-javaPath').value.trim(),
        javaArgs: $('cfg-javaArgs').value.trim(),
        botName: $('cfg-botName').value.trim(),
        serverPort: Number($('cfg-serverPort').value) || 25565,
        mindserverPort: Number($('cfg-mindserverPort').value) || 8080,
    };
    const r = await api.setConfig(next);
    state.cfg = { ...state.cfg, ...next };
    toast(r.msg, 'ok');
    refresh();
});

$('cfg-open').addEventListener('click', async () => {
    const r = await api.openPath(state.cfg.javaPath);
    if (r && r.msg) toast(r.msg, r.ok ? 'ok' : 'err');
});

// ------------------------------------------------------------------ 操作
function bindAction(ids, fn) {
    for (const id of ids) {
        const el = $(id);
        if (!el) continue;
        el.addEventListener('click', async () => {
            el.disabled = true;
            try {
                const r = await fn();
                if (r && r.msg) toast(r.msg, r.ok ? 'ok' : 'err');
            } catch (e) {
                toast('操作失败：' + (e && e.message ? e.message : e), 'err');
            } finally {
                setTimeout(() => { el.disabled = false; refresh(); }, 400);
            }
        });
    }
}

bindAction(['ov-btn-server-start', 'sv-btn-start'], () => api.startServer());
bindAction(['ov-btn-server-stop', 'sv-btn-stop'], () => api.stopServer());
bindAction(['ov-btn-bot-start', 'bt-btn-start'], () => api.startBot());
bindAction(['ov-btn-bot-stop', 'bt-btn-stop'], () => api.stopBot());

async function doSay(inputId) {
    const input = $(inputId);
    const text = input.value.trim();
    if (!text) { toast('先写点什么再发', 'err'); return; }
    input.value = '';
    try {
        const r = await api.say(text);
        toast(r.msg, r.ok ? 'ok' : 'err');
    } catch (e) {
        toast('发送失败：' + e.message, 'err');
    }
}
$('ov-say-btn').addEventListener('click', () => doSay('ov-say-input'));
$('bt-say-btn').addEventListener('click', () => doSay('bt-say-input'));
$('ov-say-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSay('ov-say-input'); });
$('bt-say-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSay('bt-say-input'); });

$('sv-btn-open').addEventListener('click', () => api.openPath(state.cfg.serverDir));
$('log-open-dir').addEventListener('click', () => api.openPath(state.cfg.serverDir + '/logs'));
$('log-clear').addEventListener('click', async () => {
    await api.clearLogs();
    state.logs = []; state.chats = [];
    $('ov-log').textContent = ''; $('sv-log').textContent = '';
    renderFullLog(); renderChats();
    toast('显示已清空（不影响磁盘日志）', 'ok');
});
$('bt-btn-ui').addEventListener('click', () => {
    window.open('http://localhost:' + (state.cfg.mindserverPort || 8080), '_blank');
});
$('btn-refresh').addEventListener('click', () => { refresh(); poll(); toast('已刷新'); });

// ------------------------------------------------------------------ 增量拉取
let polling = false;
async function poll() {
    if (polling) return;
    polling = true;
    try {
        const r = await get('/api/logs?since=' + state.since);
        state.since = r.next;
        for (const e of r.logs) onLog(e);
        for (const c of r.chats) onChat(c);
    } catch { /* 后端短暂不可用时静默 */ }
    polling = false;
}

// ------------------------------------------------------------------ 启动
(async function boot() {
    await loadConfig();
    const h = await api.history();
    state.logs = h.logs || [];
    state.chats = h.chats || [];
    state.since = h.next || 0;
    for (const e of state.logs) {
        appendToBox($('ov-log'), e, 40);
        if (e.src === 'server' || e.src === 'panel') appendToBox($('sv-log'), e, 150);
    }
    renderChats();

    await refresh();
    setInterval(refresh, 2500);
    setInterval(poll, 1000);

    // 心跳：窗口关掉后后端会自动退出
    const beat = () => fetch('/api/beat').catch(() => {});
    beat();
    setInterval(beat, 3000);
})();
