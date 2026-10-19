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
    say: (text, to) => post('/api/say', { text, to }),
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

// 心跳必须在最早期就开始跑：后端靠它判断"窗口还在不在"，
// 一旦放到 boot() 末尾，加载中途出错就会导致窗口开着、后端却退出。
(function startHeartbeat() {
    const beat = () => fetch('/api/beat').catch(() => {});
    beat();
    setInterval(beat, 3000);
})();

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

    const bots = s.bots || [];
    const inGame = bots.filter((b) => b.state === 'online').length;
    const created = bots.filter((b) => b.state !== 'notcreated').length;

    setDot($('dot-server'), s.server.up);
    setDot($('dot-bot'), s.bot.up, bots.length > 0);
    $('mini-server').textContent = s.server.up ? '运行中' : '已停止';
    $('mini-bot').textContent = bots.length ? inGame + '/' + bots.length + ' 在线' : '无';
    $('mini-players').textContent = s.players.length + ' 人';

    setDot($('c-dot-server'), s.server.up);
    setDot($('c-dot-bot'), inGame > 0, s.bot.up && inGame === 0);
    $('ov-server-state').textContent = s.server.up ? (s.server.owned ? '运行中（面板启动）' : '运行中（外部启动）') : '已停止';
    $('ov-server-port').textContent = s.server.port;
    $('ov-server-pid').textContent = s.server.pid || '—';
    $('ov-bot-state').textContent = !s.bot.up
        ? (bots.length ? 'MindServer 未启动' : '还没配置机器人')
        : inGame + ' 个在线 / 共 ' + bots.length + ' 个';
    $('ov-bot-count').textContent = bots.length + ' 个';
    renderBotMini(bots);
    $('ov-btn-server-start').disabled = s.server.up;
    $('ov-btn-server-stop').disabled = !s.server.owned;
    $('ov-btn-bot-start').disabled = bots.length === 0;
    $('ov-btn-bot-stop').disabled = created === 0;

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

    $('bt-state').textContent = s.bot.up
        ? '运行中（127.0.0.1:' + s.bot.port + '）· ' + inGame + '/' + bots.length + ' 在线'
        : (bots.length ? '未启动（点「启动全部」）' : '还没配置机器人');
    $('bt-mind-hint').textContent = 'MindServer :' + s.bot.port;
    renderBotList(bots);
    fillSayTargets(bots);
    $('bt-btn-start').disabled = bots.length === 0;
    $('bt-btn-stop').disabled = created === 0;
    $('bt-btn-shutdown').disabled = !s.bot.up;
    $('chip-port').textContent = ':' + s.server.port;
}

// ------------------------------------------------------------------ 机器人列表
const STATE_LABEL = { online: '在线', starting: '进服中', offline: '已停止', notcreated: '未启动' };

function makeDot(ok, warn) {
    const d = document.createElement('span');
    d.className = 'card-dot dot';
    setDot(d, ok, warn);
    return d;
}

function renderBotMini(bots) {
    const box = $('ov-bot-list');
    if (!box) return;
    box.textContent = '';
    if (!bots.length) {
        const e = document.createElement('div');
        e.className = 'bot-empty';
        e.textContent = '还没有机器人，去「AI 机器人」页添加';
        box.appendChild(e);
        return;
    }
    for (const b of bots) {
        const row = document.createElement('div');
        row.className = 'bot-mini';
        row.appendChild(makeDot(b.state === 'online', b.state === 'starting'));
        const n = document.createElement('span');
        n.textContent = b.name;
        const m = document.createElement('span');
        m.className = 'bot-mini-meta';
        m.textContent = STATE_LABEL[b.state] || b.state;
        row.appendChild(n);
        row.appendChild(m);
        box.appendChild(row);
    }
}

function renderBotList(bots) {
    const box = $('bot-list');
    if (!box) return;
    box.textContent = '';
    if (!bots.length) {
        const e = document.createElement('div');
        e.className = 'bot-empty';
        e.textContent = '还没有机器人，用下面的表单添加一个';
        box.appendChild(e);
        return;
    }
    for (const b of bots) {
        const row = document.createElement('div');
        row.className = 'bot-row';
        row.dataset.name = b.name;
        row.appendChild(makeDot(b.state === 'online', b.state === 'starting'));

        const name = document.createElement('span');
        name.className = 'bot-name';
        name.textContent = b.name;
        row.appendChild(name);

        const meta = document.createElement('span');
        meta.className = 'bot-meta';
        meta.textContent = (b.model || '') + ' · ' + (STATE_LABEL[b.state] || b.state);
        row.appendChild(meta);

        if (b.enabled === false) {
            const tag = document.createElement('span');
            tag.className = 'bot-tag';
            tag.textContent = '已禁用';
            row.appendChild(tag);
        }

        const mk = (act, label, cls) => {
            const btn = document.createElement('button');
            btn.className = 'btn ' + cls;
            btn.dataset.act = act;
            btn.textContent = label;
            if (act === 'start') btn.disabled = b.state === 'online' || b.state === 'starting';
            if (act === 'stop') btn.disabled = b.state === 'notcreated';
            row.appendChild(btn);
        };
        mk('start', '启动', 'btn-green');
        mk('stop', '停止', 'btn-red');
        mk('delete', '删除', '');
        box.appendChild(row);
    }
}

function fillSayTargets(bots) {
    for (const id of ['bt-say-target', 'ov-say-target']) {
        const sel = $(id);
        if (!sel) continue;
        const cur = sel.value;
        sel.textContent = '';
        sel.add(new Option('发给全部', '__all__'));
        for (const b of bots) sel.add(new Option(b.name, b.name));
        const has = [...sel.options].some((o) => o.value === cur);
        sel.value = has ? cur : '__all__';
    }
}

$('bot-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const row = btn.closest('.bot-row');
    const name = row && row.dataset.name;
    if (!name) return;
    const act = btn.dataset.act;
    btn.disabled = true;
    try {
        const r = act === 'start' ? await post('/api/bots/start', { name })
            : act === 'stop' ? await post('/api/bots/stop', { name })
                : await post('/api/bots/delete', { name });
        if (r && r.msg) toast(r.msg, r.ok ? 'ok' : 'err');
    } catch (err) {
        toast('操作失败：' + (err && err.message ? err.message : err), 'err');
    }
    setTimeout(() => { refresh(); }, 600);
});

// ------------------------------------------------------------------ 配置
async function loadConfig() {
    state.cfg = await api.getConfig();
    $('cfg-serverDir').value = state.cfg.serverDir;
    $('cfg-mindcraftDir').value = state.cfg.mindcraftDir;
    $('cfg-javaPath').value = state.cfg.javaPath;
    $('cfg-javaArgs').value = state.cfg.javaArgs;
    $('cfg-mcVersion').value = state.cfg.mcVersion || '1.20.1';
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
        mcVersion: $('cfg-mcVersion').value.trim() || '1.20.1',
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
    const sel = targetId ? $(targetId) : null;
    const to = sel ? sel.value : '__all__';
    try {
        const r = await api.say(text, to);
        toast(r.msg, r.ok ? 'ok' : 'err');
    } catch (e) {
        toast('发送失败：' + e.message, 'err');
    }
}
$('ov-say-btn').addEventListener('click', () => doSay('ov-say-input', 'ov-say-target'));
$('bt-say-btn').addEventListener('click', () => doSay('bt-say-input', 'bt-say-target'));
$('ov-say-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSay('ov-say-input', 'ov-say-target'); });
$('bt-say-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSay('bt-say-input', 'bt-say-target'); });

// 添加机器人（添加后立刻启动它）
$('nb-add').addEventListener('click', async () => {
    const body = {
        name: $('nb-name').value.trim(),
        model: $('nb-model').value.trim(),
        api: $('nb-api').value.trim(),
        url: $('nb-url').value.trim(),
        initMessage: $('nb-init').value.trim(),
    };
    if (!body.name) { toast('先给机器人起个名字', 'err'); return; }
    const r = await post('/api/bots', body);
    toast(r.msg, r.ok ? 'ok' : 'err');
    if (!r.ok) return;
    $('nb-name').value = '';
    $('nb-init').value = '';
    const s = await post('/api/bots/start', { name: body.name });
    if (s && s.msg) toast(s.msg, s.ok ? 'ok' : 'err');
    setTimeout(refresh, 800);
});

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
$('bt-btn-shutdown').addEventListener('click', async () => {
    const r = await post('/api/bot/shutdown', {});
    if (r && r.msg) toast(r.msg, r.ok ? 'ok' : 'err');
    setTimeout(refresh, 1500);
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
})();
