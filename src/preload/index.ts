import { contextBridge, ipcRenderer } from 'electron';
import type { ProbeBridge, ProbeReport } from '../shared/probe';
import type { StockBridge, StockState } from '../shared/stock';
import type { ShortcutCapture } from '../shared/shortcuts';

const bridge: ProbeBridge = {
  run: input => ipcRenderer.invoke('probe:run', input),
  cancel: () => ipcRenderer.invoke('probe:cancel'),
  getReport: () => ipcRenderer.invoke('probe:get'),
  onReport: listener => {
    const handler = (_event: unknown, report: ProbeReport) => listener(report);
    ipcRenderer.on('probe:report', handler);
    return () => ipcRenderer.removeListener('probe:report', handler);
  },
  ready: () => ipcRenderer.send('probe:renderer-ready'),
};
contextBridge.exposeInMainWorld('openDProbe', bridge);

const stock: StockBridge = {
  saveShortcuts: input => ipcRenderer.invoke('stock:shortcuts-save', input),
  retryShortcuts: () => ipcRenderer.invoke('stock:shortcuts-retry'),
  captureShortcut: active => ipcRenderer.invoke('stock:shortcuts-capture', active),
  onShortcutCapture: listener => {
    const handler = (_event: unknown, value: ShortcutCapture) => listener(value);
    ipcRenderer.on('stock:shortcut-capture', handler);
    return () => ipcRenderer.removeListener('stock:shortcut-capture', handler);
  },
  onPage: listener => {
    const handler = (_event: unknown, direction: number) => { if (direction === -1 || direction === 1) listener(direction); };
    ipcRenderer.on('stock:page', handler);
    return () => ipcRenderer.removeListener('stock:page', handler);
  },
  get: () => ipcRenderer.invoke('stock:get'),
  onState: listener => {
    const handler = (_event: unknown, state: StockState) => listener(state);
    ipcRenderer.on('stock:state', handler);
    return () => ipcRenderer.removeListener('stock:state', handler);
  },
  connect: input => ipcRenderer.invoke('stock:connect', input),
  setConnectionMode: mode => ipcRenderer.invoke('stock:connection-mode', mode),
  loginCloud: () => ipcRenderer.invoke('stock:cloud-login'),
  cancelCloudLogin: () => ipcRenderer.invoke('stock:cloud-cancel'),
  logoutCloud: () => ipcRenderer.invoke('stock:cloud-logout'),
  lookup: symbol => ipcRenderer.invoke('stock:lookup', symbol),
  search: (query, market) => ipcRenderer.invoke('stock:search', query, market),
  refreshDirectory: () => ipcRenderer.invoke('stock:directory-refresh'),
  add: symbol => ipcRenderer.invoke('stock:add', symbol),
  setWatchlist: items => ipcRenderer.invoke('stock:watchlist', items),
  saveAppearance: input => ipcRenderer.invoke('stock:appearance', input),
  openSettings: () => ipcRenderer.send('stock:settings'),
  openOverview: () => ipcRenderer.send('stock:overview'),
  toggleOverview: () => ipcRenderer.send('stock:overview-toggle'),
  closeOverview: () => ipcRenderer.send('stock:overview-close'),
  onOverview: listener => {
    const handler = (_event: unknown, open: boolean) => listener(open);
    ipcRenderer.on('stock:panel-open', handler);
    return () => ipcRenderer.removeListener('stock:panel-open', handler);
  },
  onNotice: listener => {
    const handler = (_event: unknown, message: string) => listener(message);
    ipcRenderer.on('stock:notice', handler);
    return () => ipcRenderer.removeListener('stock:notice', handler);
  },
  menu: () => ipcRenderer.send('stock:menu'),
  hide: () => ipcRenderer.send('stock:hide'),
  ready: () => ipcRenderer.send('stock:ready'),
};
contextBridge.exposeInMainWorld('stockBar', stock);
