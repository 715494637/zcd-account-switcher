"use strict";

/**
 * preload - 安全桥接。渲染进程只能通过 window.api 调用主进程。
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  status: () => ipcRenderer.invoke("app:status"),
  list: () => ipcRenderer.invoke("account:list"),
  quota: (id) => ipcRenderer.invoke("account:quota", id),
  quotaMany: (ids) => ipcRenderer.invoke("account:quota-many", ids),
  use: (id, opts) => ipcRenderer.invoke("account:use", id, opts),
  auto: (opts) => ipcRenderer.invoke("account:auto", opts),
  rollback: () => ipcRenderer.invoke("account:rollback"),
  killZCode: () => ipcRenderer.invoke("zcode:kill"),
  launchZCode: () => ipcRenderer.invoke("zcode:launch"),
  remove: (ids) => ipcRenderer.invoke("account:remove", ids),
  clearDead: () => ipcRenderer.invoke("account:clear-dead"),
  importDialog: () => ipcRenderer.invoke("account:import-dialog"),
  importText: (text) => ipcRenderer.invoke("account:import-text", text),
  exportCards: (opts) => ipcRenderer.invoke("account:export-cards", opts),
  saveCardsFile: (text) => ipcRenderer.invoke("account:save-cards-file", text),
  markSold: (ids) => ipcRenderer.invoke("account:mark-sold", ids),
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
  // dev 注册机
  regStart: (opts) => ipcRenderer.invoke("reg:start", opts),
  regBatch: () => ipcRenderer.invoke("reg:batch"),
  regCards: (ids) => ipcRenderer.invoke("reg:cards", ids),
  regImportToPool: (ids) => ipcRenderer.invoke("reg:import-to-pool", ids),
  regEndBatch: () => ipcRenderer.invoke("reg:end-batch"),
  regRemove: (ids) => ipcRenderer.invoke("reg:remove", ids),
  onRegJob: (cb) => {
    const h = (_e, job) => cb(job);
    ipcRenderer.on("reg:job", h);
    return () => ipcRenderer.removeListener("reg:job", h);
  },
});
