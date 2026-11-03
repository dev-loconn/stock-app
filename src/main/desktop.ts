import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, nativeTheme, screen, safeStorage, powerMonitor, shell, type IpcMainInvokeEvent, type IpcMainEvent } from 'electron';
import { join, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { SettingsStore } from './settings';
import { MarketService } from './market-service';
import { CloudAuth } from './cloud-auth';
import { cloudError } from './cloud-api';
import { cloudRequest, openCloudSocket } from './cloud-network';
import { SecurityCatalog } from './security-catalog';
import { AKShareDirectory } from './akshare-directory';
import { barItems, barWidth, normalizeSymbol, validateAppearance, MARKET_NAMES, SECURITY_MARKETS, type WatchItem } from '../shared/stock';
import { BarVisibility } from './visibility';
import { FullscreenWatcher } from './fullscreen';
import { WatchlistPanel } from './watchlist-panel';
import { NativeShortcuts, ShortcutManager } from './shortcuts';
import type { ShortcutAction } from '../shared/shortcuts';

const page = resolve(__dirname, '../../dist/index.html');
const pageURL = pathToFileURL(page).href;
const fullscreenLiveCheck = process.argv.includes('--fullscreen-live-check');
const recoveryLiveCheck = process.argv.includes('--recovery-live-check');
const systemRecoveryCheck = process.argv.includes('--system-recovery-check');
const layoutCheck = process.argv.includes('--layout-check');
const searchCheck = process.argv.includes('--search-check');
const searchLiveCheck = process.argv.includes('--search-live-check');
const cloudCheck = process.argv.includes('--cloud-check');
const panelCheck = process.argv.includes('--panel-check');
const shortcutsCheck = process.argv.includes('--shortcuts-check');
const recoveryCheck = process.argv.includes('--recovery-check') || recoveryLiveCheck;
const fullscreenCheck = process.argv.includes('--fullscreen-check') || fullscreenLiveCheck;
const check = process.argv.includes('--smoke') || process.argv.includes('--ui-check') || fullscreenCheck || recoveryCheck || systemRecoveryCheck || layoutCheck || searchCheck || searchLiveCheck || cloudCheck || panelCheck || shortcutsCheck;
const visibleCheck = process.argv.includes('--ui-check') || fullscreenCheck || recoveryCheck || systemRecoveryCheck || panelCheck || shortcutsCheck;
const recordLive = process.argv.includes('--record-live');
let store: SettingsStore;
let service: MarketService;
let cloudAuth: CloudAuth;
let catalog: SecurityCatalog;
let directorySource: AKShareDirectory;
let catalogTimer: ReturnType<typeof setInterval> | undefined;
let topmostTimer: ReturnType<typeof setInterval> | undefined;
let bar: BrowserWindow;
let settings: BrowserWindow | undefined;
let panel: WatchlistPanel | undefined;
let shortcuts: ShortcutManager | undefined;
let tray: Tray;
let quitting = false;
let moveTimer: ReturnType<typeof setTimeout> | undefined;
let evidenceTimer: ReturnType<typeof setTimeout> | undefined;
let fullscreenWatcher: FullscreenWatcher | undefined;
let fullscreenReadyTimer: ReturnType<typeof setTimeout> | undefined;
let fullscreenHealth: 'starting' | 'active' | 'unavailable' = 'starting';
const visibility = new BarVisibility(visible => {
  if (!bar || bar.isDestroyed()) return;
  if (visible) bar.showInactive(); else { panel?.close(); bar.hide(); }
});
const sourceSettingsPath = join(app.getPath('userData'), 'stock-bar-settings.json');
const profile = process.env.STOCK_BAR_TEST_PROFILE;
if (check && profile) app.setPath('userData', resolve(profile));

function authorize(event: IpcMainInvokeEvent | IpcMainEvent, role?: 'settings' | 'bar' | 'overview') {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || ![bar, settings, panel?.getWindow()].includes(owner) || event.senderFrame !== event.sender.mainFrame
    || event.senderFrame.url.split('?')[0] !== pageURL || (role === 'settings' && owner !== settings) || (role === 'bar' && owner !== bar)
    || (role === 'overview' && owner !== panel?.getWindow())) {
    throw new Error('IPC 来源无效');
  }
}
function state() { return { ...service.state(store.keySaved), preferences: store.preferences, settingsWarning: store.warning, directory: catalog.state(), shortcuts: shortcuts?.snapshot() }; }
function broadcast() {
  if (!service || !catalog || !bar) return;
  const value = state();
  panel?.reposition();
  for (const window of [bar, settings, panel?.getWindow()]) if (window && !window.isDestroyed()) window.webContents.send('stock:state', value);
  if (check && value.connection === 'connected' && value.preferences.connectionMode === 'opend') void catalog.refresh();
  if (recordLive && value.rows.some(row => row.quote) && !evidenceTimer) {
    evidenceTimer = setTimeout(() => { evidenceTimer = undefined; void captureEvidence().catch(() => undefined); }, 1500);
  }
}
function secureWindow(window: BrowserWindow) {
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
}
function webPreferences() { return { preload: join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: !(layoutCheck || searchCheck || searchLiveCheck || cloudCheck) }; }
function clampBounds(x: number, y: number, width: number, height: number) {
  const display = screen.getDisplayNearestPoint({ x, y }).bounds;
  width = Math.min(width, display.width);
  height = Math.min(height, display.height);
  return {
    x: Math.max(display.x, Math.min(x, display.x + display.width - width)),
    y: Math.max(display.y, Math.min(y, display.y + display.height - height)),
    width,
    height,
  };
}
function applyAppearance() {
  const preferences = store.preferences;
  const work = screen.getDisplayMatching(bar.getBounds()).workArea;
  const width = barWidth(work.width, preferences.securityWidth, barItems(preferences.watchlist).length, preferences.barPageSize);
  const height = Math.max(44, Math.round(preferences.fontSize * 2.6 + 8));
  const bounds = bar.getBounds();
  bar.setBounds(clampBounds(bounds.x, bounds.y, width, height));
  bar.setOpacity(preferences.opacity);
  panel?.reposition();
}
function restoreBar() { visibility.restore(); }
function hideBar() { visibility.hide(); }
function shortcutAction(action: ShortcutAction) {
  const current = visibility.snapshot();
  if (current.fullscreen || bar.isDestroyed()) return;
  if (action === 'toggleBar') { if (current.manualHidden) restoreBar(); else hideBar(); }
  else if (action === 'togglePanel') panel?.toggle(false);
  else if (bar.isVisible()) bar.webContents.send('stock:page', action === 'previousPage' ? -1 : 1);
}
function openSettings() {
  panel?.close();
  if (check && !layoutCheck && !searchCheck && !searchLiveCheck && !cloudCheck && !panelCheck && !shortcutsCheck) return;
  if (settings && !settings.isDestroyed()) { if (!layoutCheck && !searchCheck && !searchLiveCheck && !cloudCheck) { settings.show(); settings.focus(); } return; }
  settings = new BrowserWindow({ width: 840, height: 790, minWidth: 660, minHeight: 560, show: false,
    title: '行情悬浮条 · 设置与自选', backgroundColor: '#10151f', accentColor: '#10151f', webPreferences: webPreferences() });
  secureWindow(settings);
  settings.once('ready-to-show', () => { if (!layoutCheck && !searchCheck && !searchLiveCheck && !cloudCheck) { settings?.show(); settings?.focus(); } });
  settings.on('blur', () => { void shortcuts?.cancelRecording().catch(() => undefined); });
  settings.on('closed', () => { void shortcuts?.cancelRecording().catch(() => undefined); settings = undefined; });
  void settings.loadFile(page, { query: { view: 'settings' } });
}
function openOverview() {
  return panel!.open();
}
function refreshWatchlist() {
  const previous = service.state(store.keySaved).preferences.watchlist.map(item => item.symbol).sort().join();
  const current = store.preferences.watchlist.map(item => item.symbol).sort().join();
  service.configure(store.preferences, store.key, previous !== current);
  applyAppearance(); broadcast();
}
function showMenu() {
  Menu.buildFromTemplate([
    { label: '查看行情', click: openOverview },
    { label: '自选管理 / 连接设置', click: openSettings },
    { type: 'separator' }, { label: '重新连接', click: () => service.reconnect() },
    { label: bar.isVisible() ? '隐藏悬浮条' : '恢复悬浮条', click: () => bar.isVisible() ? hideBar() : restoreBar() },
    { type: 'separator' }, { label: '退出', click: () => app.quit() },
  ]).popup();
}
async function captureEvidence() {
  const directory = resolve(process.cwd(), 'artifacts'); await mkdir(directory, { recursive: true });
  const snapshot = state();
  await writeFile(join(directory, 'stock-bar-live.json'), JSON.stringify({ capturedAt: new Date().toISOString(),
    runtime: { electron: process.versions.electron, sdk: require('futu-api/package.json').version },
    window: { ...visibility.snapshot(), visible: bar.isVisible(), focusable: bar.isFocusable(), alwaysOnTop: bar.isAlwaysOnTop(), bounds: bar.getBounds(), fullscreenHealth },
    ...snapshot }, null, 2) + '\n');
  if (bar.isVisible()) await writeFile(join(directory, 'stock-bar-live.png'), (await bar.webContents.capturePage()).toPNG());
}
ipcMain.handle('stock:get', event => { authorize(event); return state(); });
ipcMain.handle('stock:connect', async (event, value: unknown) => {
  authorize(event, 'settings');
  try {
    if (store.preferences.watchlist.some(item => item.symbol.startsWith('BJ.'))) throw Error('北交所行情请使用富途云端连接');
    cloudAuth.cancelLogin(); await store.setConnection(value); service.configure(store.preferences, store.key); broadcast(); return { ok: true };
  }
  catch (error) { return { ok: false, message: error instanceof Error ? error.message : '连接设置保存失败' }; }
});
ipcMain.handle('stock:connection-mode', async (event, mode: unknown) => {
  authorize(event, 'settings');
  if (mode !== 'cloud' && mode !== 'opend') return { ok: false, message: '连接方式无效' };
  const previous = store.preferences;
  try {
    if (mode === 'opend' && previous.watchlist.some(item => item.symbol.startsWith('BJ.'))) throw Error('北交所行情请使用富途云端连接');
    cloudAuth.cancelLogin(); await store.update(current => ({ ...current, connectionMode: mode }));
    service.configure(store.preferences, store.key); broadcast(); return { ok: true };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : '连接方式保存失败' }; }
});
ipcMain.handle('stock:cloud-login', async event => {
  authorize(event, 'settings');
  if (store.preferences.connectionMode !== 'cloud') return { ok: false, message: '请先选择富途云端连接' };
  try {
    service.stop(); await cloudAuth.login();
    if (store.preferences.connectionMode === 'cloud') service.reset(store.preferences, store.key);
    broadcast(); return { ok: true, message: '已完成富途授权，正在连接云端行情' };
  } catch (error) { if (store.preferences.connectionMode === 'cloud') service.reset(store.preferences, store.key); broadcast(); return { ok: false, message: cloudError(error) }; }
});
ipcMain.handle('stock:cloud-cancel', event => { authorize(event, 'settings'); cloudAuth.cancelLogin(); return { ok: true }; });
ipcMain.handle('stock:cloud-logout', async event => {
  authorize(event, 'settings');
  try {
    if (store.preferences.connectionMode === 'cloud') service.stop();
    await cloudAuth.logout();
    if (store.preferences.connectionMode === 'cloud') service.reset(store.preferences, store.key);
    broadcast(); return { ok: true, message: '已退出云端登录' };
  } catch { broadcast(); return { ok: false, message: '本机授权清除未能保存，请重试退出登录' }; }
});
ipcMain.handle('stock:lookup', async (event, symbol: unknown) => {
  authorize(event, 'settings');
  try { return { item: await service.lookup(symbol) }; } catch (error) { return { message: error instanceof Error ? error.message : '查询失败' }; }
});
ipcMain.handle('stock:search', (event, query: unknown, market: unknown) => {
  authorize(event, 'settings'); return catalog.search(query, market);
});
ipcMain.handle('stock:directory-refresh', async event => {
  authorize(event, 'settings');
  if (check && store.preferences.connectionMode === 'opend' && state().connection !== 'connected') return { ok: false, message: '请先连接行情服务，再刷新证券目录' };
  const result = await catalog.refresh(true);
  const failed = result.markets.filter(item => item.error);
  return { ok: !failed.length, message: failed.length ? failed.map(item => `${MARKET_NAMES[item.market]}：${item.error}`).join('；') : '港美 A 股证券目录已更新' };
});
ipcMain.handle('stock:add', async (event, value: unknown) => {
  authorize(event, 'settings');
  try {
    const symbol = normalizeSymbol(value);
    await store.update(async current => {
      if (current.watchlist.some(item => item.symbol === symbol)) throw Error('该证券已添加');
      const item = await service.lookup(symbol);
      return { ...current, watchlist: [...current.watchlist, { ...item, showInBar: false }] };
    });
    refreshWatchlist();
    return { ok: true, message: '证券已加入自选，展示勾选请在列表中调整' };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : '添加失败' }; }
});
ipcMain.handle('stock:watchlist', async (event, value: unknown) => {
  authorize(event, 'settings');
  try {
    if (!Array.isArray(value)) throw new Error('自选列表无效');
    await store.update(async current => {
      const items: WatchItem[] = [];
      const symbols = value.map(item => normalizeSymbol(item?.symbol));
      if (new Set(symbols).size !== symbols.length) throw Error('证券不能重复');
      for (const valueItem of value) {
        const symbol = normalizeSymbol(valueItem?.symbol);
        if (valueItem.showInBar !== undefined && typeof valueItem.showInBar !== 'boolean') throw Error('展示选择无效');
        const existing = current.watchlist.find(item => item.symbol === symbol);
        const item = existing || await service.lookup(symbol);
        items.push({ ...item, showInBar: valueItem.showInBar ?? existing?.showInBar ?? false });
      }
      return { ...current, watchlist: items };
    });
    refreshWatchlist(); return { ok: true };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : '自选保存失败' }; }
});
ipcMain.handle('stock:appearance', async (event, value: unknown) => {
  authorize(event, 'settings');
  const previous = store.preferences;
  try {
    const appearance = validateAppearance(value);
    if (!check) app.setLoginItemSettings({ openAtLogin: appearance.autoStart, path: process.execPath,
      args: app.isPackaged ? [] : [app.getAppPath()] });
    try { await store.update(current => ({ ...current, ...appearance })); }
    catch (error) {
      if (!check) {
        try { app.setLoginItemSettings({ openAtLogin: previous.autoStart, path: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] }); }
        catch { return { ok: false, message: '外观保存失败，开机自启状态恢复失败，请检查系统启动应用设置' }; }
      }
      throw error;
    }
    refreshWatchlist(); return { ok: true };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : '外观保存失败' }; }
});
ipcMain.on('stock:settings', event => { authorize(event); openSettings(); });
ipcMain.handle('stock:shortcuts-save', async (event, input: unknown) => {
  authorize(event, 'settings');
  try {
    if (!shortcuts) throw Error('快捷键服务未启用');
    await shortcuts.save(input, bindings => store.setShortcuts(bindings));
    broadcast(); return { ok: true };
  } catch (error) { broadcast(); return { ok: false, message: error instanceof Error ? error.message : '快捷键保存失败' }; }
});
ipcMain.handle('stock:shortcuts-retry', async event => {
  authorize(event, 'settings');
  try {
    if (!shortcuts) throw Error('快捷键服务未启用');
    await shortcuts.retry(); broadcast();
    const failed = Object.values(shortcuts.snapshot()).some(value => !value.active && value.message !== '已禁用');
    return { ok: !failed, message: failed ? '部分组合仍无法注册，请查看各项状态' : '已重新注册快捷键' };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : '快捷键服务不可用' }; }
});
ipcMain.handle('stock:shortcuts-capture', async (event, active: unknown) => {
  authorize(event, 'settings');
  try {
    if (typeof active !== 'boolean' || !shortcuts) throw Error('快捷键录入不可用');
    if (active && !settings!.isFocused()) throw Error('请先切换到设置窗口');
    const handle = settings!.getNativeWindowHandle();
    await shortcuts.record(active, handle.length === 8 ? handle.readBigUInt64LE().toString() : handle.readUInt32LE().toString());
    return { ok: true };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : '录入失败' }; }
});
ipcMain.on('stock:overview', event => { authorize(event); openOverview(); });
ipcMain.on('stock:overview-toggle', event => { authorize(event, 'bar'); panel!.toggle(); });
ipcMain.on('stock:overview-close', event => { authorize(event, 'overview'); panel!.close(); });
ipcMain.on('stock:menu', event => { authorize(event, 'bar'); showMenu(); });
ipcMain.on('stock:hide', event => { authorize(event, 'bar'); hideBar(); });
ipcMain.on('stock:ready', event => { authorize(event); event.sender.send('stock:state', state()); event.sender.send('stock:panel-open', panel?.isOpen() || false); });

if (!app.requestSingleInstanceLock()) {
  if (check) { console.error('已有悬浮条实例，请先退出再运行 UI 检查'); app.exit(1); } else app.quit();
} else {
  app.on('second-instance', (_event, args) => {
    if (args.includes('--capture')) void captureEvidence();
    else if (args.includes('--catalog-cloud-live-check') && store.preferences.connectionMode === 'cloud') {
      void import('./catalog-cloud-check.js').then(module => module.checkCatalogCloud(catalog, cloudAuth, cloudRequest))
        .catch(() => console.error('目录云端核验未完成；未记录凭证'));
    } else { restoreBar(); openSettings(); }
  });
  void app.whenReady().then(async () => {
    // Match native window painting to the dark UI, including shaped corner edges.
    nativeTheme.themeSource = 'dark';
    store = new SettingsStore(searchLiveCheck ? sourceSettingsPath : join(app.getPath('userData'), 'stock-bar-settings.json'), {
      available: () => safeStorage.isEncryptionAvailable(), encrypt: text => safeStorage.encryptString(text), decrypt: data => safeStorage.decryptString(data),
    });
    await store.load(!searchLiveCheck);
    const cloud = cloudCheck ? (await import('./cloud-check.js')).cloudFixture() : { request: cloudRequest, socket: openCloudSocket, browser: (url: string) => shell.openExternal(url) };
    cloudAuth = new CloudAuth(join(app.getPath('userData'), 'stock-bar-cloud.json'), {
      available: () => safeStorage.isEncryptionAvailable(), encrypt: text => safeStorage.encryptString(text), decrypt: data => safeStorage.decryptString(data),
    }, cloud.request, cloud.browser, broadcast, cloudCheck ? { port: 0, timeoutMs: 15000 } : undefined);
    await cloudAuth.load();
    service = new MarketService(store.preferences, broadcast, cloudAuth, cloud.request, cloud.socket);
    directorySource = new AKShareDirectory(app.getAppPath(), undefined, { requireBundled: app.isPackaged });
    const directoryPath = check ? searchLiveCheck ? resolve('artifacts/search-live/security-directory.json') : join(app.getPath('userData'), 'security-directory.json')
      : app.isPackaged ? join(app.getPath('userData'), 'security-directory-akshare.json') : join(app.getAppPath(), '.cache', 'security-directory-akshare.json');
    catalog = new SecurityCatalog(directoryPath, market => cloudCheck && 'directory' in cloud ? cloud.directory(market)
      : check ? service.directory(market) : directorySource.fetch(market), broadcast, Date.now,
      check && !cloudCheck ? ['HK', 'US'] : SECURITY_MARKETS);
    await catalog.load();
    catalogTimer = setInterval(() => { if (!check || state().connection === 'connected' && store.preferences.connectionMode === 'opend') void catalog.refresh(); }, 60000);
    if (!check) void catalog.refresh();
    const work = screen.getPrimaryDisplay().workArea;
    const width = barWidth(work.width, store.preferences.securityWidth, barItems(store.preferences.watchlist).length, store.preferences.barPageSize);
    const position = store.preferences.position || { x: work.x + work.width - width - 24, y: work.y + 24 };
    bar = new BrowserWindow({ ...clampBounds(position.x, position.y, width, 44),
      frame: false, resizable: false, focusable: false, skipTaskbar: true, show: false,
      title: '股票行情悬浮条', backgroundColor: '#101824', webPreferences: webPreferences() });
    bar.setAlwaysOnTop(true, 'pop-up-menu');
    // A native window can lose its topmost flag while the app is running. Restore
    // it only when necessary, without activating the bar or showing a hidden one.
    topmostTimer = setInterval(() => {
      if (!bar.isDestroyed() && bar.isVisible() && !bar.isAlwaysOnTop()) bar.setAlwaysOnTop(true, 'pop-up-menu');
    }, 2000);
    secureWindow(bar); applyAppearance();
    panel = new WatchlistPanel({ bar, page, webPreferences: webPreferences(), secure: secureWindow,
      content: () => ({ rows: store.preferences.watchlist.length, fontSize: store.preferences.fontSize }),
      restore: restoreBar, blocked: () => visibility.snapshot().fullscreen,
      blockedNotice: () => {
        const message = '当前全屏自动隐藏中，请退出全屏后再查看行情';
        settings?.webContents.send('stock:notice', message);
        tray?.displayBalloon({ title: '自选行情', content: message, iconType: 'info' });
      },
      changed: open => { if (!bar.isDestroyed()) bar.webContents.send('stock:panel-open', open); }, hidden: layoutCheck });
    bar.once('ready-to-show', () => {
      if (check && !fullscreenCheck) { if (visibleCheck) visibility.setReady(); return; }
      // Wait for the first native sample to avoid flashing over an existing fullscreen app.
      fullscreenWatcher = new FullscreenWatcher(join(__dirname, '../native/fullscreen-monitor.exe'), bar.getNativeWindowHandle(), sample => {
        fullscreenHealth = 'active'; visibility.setSample(sample); clearTimeout(fullscreenReadyTimer); visibility.setReady();
      }, () => {
        fullscreenHealth = 'unavailable'; visibility.unavailable(); clearTimeout(fullscreenReadyTimer); visibility.setReady();
      });
      fullscreenWatcher.start();
      fullscreenReadyTimer = setTimeout(() => { fullscreenHealth = 'unavailable'; visibility.setReady(); }, 2000);
    });
    bar.on('move', () => {
      clearTimeout(moveTimer); panel?.reposition();
      if (check) return;
      moveTimer = setTimeout(() => { const bounds = bar.getBounds(); void store.update(current => ({ ...current, position: { x: bounds.x, y: bounds.y } })).catch(() => undefined); }, 350);
    });
    bar.on('resize', () => panel?.reposition());
    bar.on('hide', () => panel?.close());
    bar.on('close', event => { if (!quitting) { event.preventDefault(); hideBar(); } });
    await bar.loadFile(page, { query: { view: 'bar' } });
    if (!check || shortcutsCheck) {
      shortcuts = new ShortcutManager(store.preferences.shortcuts,
        (event, unavailable) => new NativeShortcuts(join(__dirname, '../native/shortcut-monitor.exe'), event, unavailable),
        shortcutAction, capture => { if (settings && !settings.isDestroyed()) settings.webContents.send('stock:shortcut-capture', capture); }, broadcast);
      await shortcuts.retry().catch(() => undefined);
      broadcast();
    }
    powerMonitor.on('resume', () => service.reconnect());
    powerMonitor.on('suspend', () => service.suspend());
    if (!check) {
      const bitmap = Buffer.alloc(20 * 20 * 4);
      for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) {
        const visible = x >= 3 && x <= 6 && y >= 11 || x >= 8 && x <= 11 && y >= 6 || x >= 13 && x <= 16 && y >= 2;
        const offset = (y * 20 + x) * 4; bitmap[offset] = 230; bitmap[offset + 1] = 175; bitmap[offset + 2] = 98; bitmap[offset + 3] = visible ? 255 : 0;
      }
      tray = new Tray(nativeImage.createFromBitmap(bitmap, { width: 20, height: 20 }));
      tray.setToolTip('股票行情悬浮条'); tray.on('click', restoreBar);
      tray.setContextMenu(Menu.buildFromTemplate([{ label: '恢复悬浮条', click: restoreBar }, { label: '查看行情', click: openOverview }, { label: '自选管理 / 设置', click: openSettings },
        { label: '隐藏悬浮条', click: hideBar }, { type: 'separator' }, { label: '退出', click: () => app.quit() }]));
      service.configure(store.preferences, store.key);
      if (process.argv.includes('--catalog-cloud-live-check') && store.preferences.connectionMode === 'cloud') {
        void import('./catalog-cloud-check.js').then(module => module.checkCatalogCloud(catalog, cloudAuth, cloud.request))
          .catch(() => console.error('目录云端核验未完成，请检查登录状态；未记录凭证'));
      }
      if (!store.preferences.watchlist.length || (store.preferences.connectionMode === 'cloud' ? cloudAuth.state().status !== 'authorized' : !store.key) || store.warning) openSettings();
      screen.on('display-removed', () => applyAppearance()); screen.on('display-metrics-changed', () => applyAppearance());
    } else if (shortcutsCheck) {
      const { runShortcutCheck } = await import('./shortcut-check.js');
      openSettings();
      await runShortcutCheck(bar, () => settings!, panel, visibility, shortcuts!, store);
      app.quit();
    } else if (panelCheck) {
      service.configure(store.preferences, store.key);
      const { runPanelCheck } = await import('./panel-check.js');
      await runPanelCheck(bar, service, panel, visibility, () => settings);
      app.quit();
    } else if (cloudCheck) {
      service.configure(store.preferences, store.key); openSettings();
      const { runCloudCheck } = await import('./cloud-check.js');
      await runCloudCheck(bar, service, () => settings); app.quit();
    } else if (searchLiveCheck) {
      service.configure(store.preferences, store.key); openSettings();
      const { runSearchLiveCheck } = await import('./search-check.js');
      await runSearchLiveCheck(service, catalog, () => settings);
      app.quit();
    } else if (searchCheck) {
      service.configure(store.preferences, store.key); openSettings();
      const { runSearchCheck } = await import('./search-check.js');
      await runSearchCheck(bar, service, () => settings);
      app.quit();
    } else if (layoutCheck) {
      service.configure(store.preferences, store.key);
      const { runLayoutCheck } = await import('./layout-check.js');
      await runLayoutCheck(bar, service, openOverview, () => settings);
      app.quit();
    } else if (systemRecoveryCheck) {
      const { runSystemRecoveryCheck } = await import('./system-recovery-check.js');
      await runSystemRecoveryCheck(bar, service, store.preferences, store.key);
      app.quit();
    } else if (recoveryCheck) {
      const { runRecoveryCheck } = await import('./recovery-check.js');
      await runRecoveryCheck(bar, service, store.preferences, store.key, visible => visible ? restoreBar() : hideBar(), recoveryLiveCheck);
      app.quit();
    } else if (fullscreenCheck) {
      const { runFullscreenCheck } = await import('./fullscreen-check.js');
      if (fullscreenLiveCheck) service.configure(store.preferences, store.key);
      await runFullscreenCheck(bar, visibility, () => fullscreenHealth, fullscreenLiveCheck ? () => state() : undefined);
      app.quit();
    } else {
      await new Promise(resolveWait => setTimeout(resolveWait, process.argv.includes('--topmost-check') ? 10000 : 300));
      const dom = await bar.webContents.executeJavaScript(`({bar:!!document.querySelector('.stock-bar'), width:innerWidth, require:typeof require, bridge:typeof window.stockBar?.get, prices:Array.from(document.querySelectorAll('.quote-line strong')).map(node=>node.textContent)})`);
      const passed = dom.bar && dom.require === 'undefined' && dom.bridge === 'function' && dom.prices.every((value: string) => value === '—') && !bar.isFocusable() && bar.isAlwaysOnTop() && (!visibleCheck || bar.isVisible());
      await mkdir(resolve(process.cwd(), 'artifacts'), { recursive: true });
      await writeFile(resolve(process.cwd(), 'artifacts/stock-bar-ui.png'), (await bar.webContents.capturePage()).toPNG());
      const result = { passed, dom, visible: bar.isVisible(), focusable: bar.isFocusable(), alwaysOnTop: bar.isAlwaysOnTop() };
      await writeFile(resolve(process.cwd(), 'artifacts/stock-bar-ui.json'), JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result)); app.exit(passed ? 0 : 1);
    }
  }).catch(error => { console.error(error instanceof Error ? error.message : '悬浮条启动失败'); app.exit(1); });
}
app.on('before-quit', () => {
  quitting = true; panel?.close(); clearTimeout(moveTimer); clearTimeout(evidenceTimer); clearTimeout(fullscreenReadyTimer);
  clearInterval(catalogTimer); clearInterval(topmostTimer);
  directorySource?.stop();
  fullscreenWatcher?.stop();
  shortcuts?.stop();
  service?.stop(); tray?.destroy();
  cloudAuth?.stop();
});
app.on('window-all-closed', () => { if (quitting) app.quit(); });
