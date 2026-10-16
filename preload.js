const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  GM_getValue: async (key, defaultValue) => {
    const val = await ipcRenderer.invoke('db-get', key);
    return val !== null ? val : defaultValue;
  },
  GM_setValue: async (key, value) => {
    await ipcRenderer.invoke('db-set', key, value);
  }
});