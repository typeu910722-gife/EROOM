// 只給桌面版自己的畫面（splash.html、import.html）用，網站頁面拿不到
const { contextBridge, ipcRenderer } = require('electron');
if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('eroomDesk', {
    importFrom: (source, pw) => ipcRenderer.invoke('eroom:import', { source, pw }),
    waitOld: () => ipcRenderer.invoke('eroom:wait-old'),
    skip: () => ipcRenderer.invoke('eroom:skip'),
    go: () => ipcRenderer.invoke('eroom:go'),
    retry: () => ipcRenderer.invoke('eroom:retry'),
    info: () => ipcRenderer.invoke('eroom:info'),
  });
}
