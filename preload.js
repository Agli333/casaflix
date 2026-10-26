'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Superficie mínima y explícita expuesta al renderer. No se expone ipcRenderer,
// ni acceso al sistema de archivos, ni ninguna ruta absoluta.
const api = Object.freeze({
  getState: () => ipcRenderer.invoke('app:get-state'),
  chooseFolder: () => ipcRenderer.invoke('library:choose-folder'),
  refreshLibrary: () => ipcRenderer.invoke('library:refresh'),
  saveThumbnail: (id, dataUrl) =>
    ipcRenderer.invoke('thumbs:save', { id, dataUrl }),
  saveProgress: (id, position, duration) =>
    ipcRenderer.invoke('progress:save', { id, position, duration }),
  clearProgress: (id) => ipcRenderer.invoke('progress:clear', id),
  getLinks: () => ipcRenderer.invoke('links:get'),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  networkStatus: () => ipcRenderer.invoke('net:status'),
});

contextBridge.exposeInMainWorld('casaflix', api);
