'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    getConfig: () => ipcRenderer.invoke('cfg:get'),
    setConfig: (cfg) => ipcRenderer.invoke('cfg:set', cfg),
    status: () => ipcRenderer.invoke('status'),
    startServer: () => ipcRenderer.invoke('server:start'),
    stopServer: () => ipcRenderer.invoke('server:stop'),
    startBot: () => ipcRenderer.invoke('bot:start'),
    stopBot: () => ipcRenderer.invoke('bot:stop'),
    say: (text, from) => ipcRenderer.invoke('say', text, from),
    history: () => ipcRenderer.invoke('logs:history'),
    clearLogs: () => ipcRenderer.invoke('logs:clear'),
    pickDir: () => ipcRenderer.invoke('pick:dir'),
    openPath: (p) => ipcRenderer.invoke('open:path', p),
    onLog: (cb) => ipcRenderer.on('log', (_e, d) => cb(d)),
    onChat: (cb) => ipcRenderer.on('chat', (_e, d) => cb(d)),
});
