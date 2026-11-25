// Preload bridge. nodeIntegration is enabled for the local, fully-offline app,
// so this file mainly documents / stamps the available IPC surface.
const { contextBridge, ipcRenderer } = require('electron');

const api = {
  ddl: {
    open: () => ipcRenderer.invoke('ddl:open')
  },
  file: {
    openAny: () => ipcRenderer.invoke('file:open-any'),
    read: (filePath) => ipcRenderer.invoke('file:read', filePath),
    saveTo: (filePath, content) => ipcRenderer.invoke('file:save-to', { path: filePath, content }),
    saveAs: (name, doc, ddlXml, defaultType) => ipcRenderer.invoke('file:save-as', { name, doc, ddlXml, defaultType }),
    openDdl: () => ipcRenderer.invoke('ddl:open')
  },
  data: {
    open: () => ipcRenderer.invoke('data:open')
  },
  exportFile: {
    png: (name, dataUrl) => ipcRenderer.invoke('export:save-png', { name, dataUrl }),
    pdf: (name, base64) => ipcRenderer.invoke('export:save-pdf', { name, base64 })
  },
  print: {
    labels: (opts) => ipcRenderer.invoke('print:labels', opts),
    raw: (opts) => ipcRenderer.invoke('print:raw', opts),
    printers: () => ipcRenderer.invoke('print:printers')
  },
  app: {
    version: () => ipcRenderer.invoke('app:version'),
    userData: () => ipcRenderer.invoke('app:userData'),
    checkUpdate: () => ipcRenderer.invoke('app:check-update'),
    openExternal: (url) => ipcRenderer.invoke('app:open-external', url)
  },
  assoc: {
    status: () => ipcRenderer.invoke('assoc:status'),
    fix: () => ipcRenderer.invoke('assoc:fix')
  },
  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    maximize: () => ipcRenderer.invoke('win:maximize'),
    close: () => ipcRenderer.invoke('win:close')
  },
  onOpenPath: (callback) => {
    ipcRenderer.on('file:open-path', (event, filePath) => callback(filePath));
  },
  rendererReady: () => ipcRenderer.invoke('renderer:ready')
};

try {
  if (contextBridge) contextBridge.exposeInMainWorld('labelApi', api);
} catch (e) { /* contextIsolation disabled: direct assignment below is enough */ }
window.labelApi = api;
