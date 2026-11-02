import { app, BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { join, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { runProbe } from './probe';
import { DEFAULT_SYMBOLS, validateInput, type ProbeReport } from '../shared/probe';

const automatic = process.argv.includes('--probe');
const smoke = process.argv.includes('--probe-smoke');
const uiCheck = process.argv.includes('--probe-ui-check');
let automaticKey = automatic ? process.env.OPEND_WS_KEY || '' : '';
delete process.env.OPEND_WS_KEY;
const page = resolve(__dirname, '../../dist/index.html');
let window: BrowserWindow | undefined;
let controller: AbortController | undefined;
let latest: ProbeReport | null = null;
let rendererReady = false;
let busy = false;
let readyTimer: ReturnType<typeof setTimeout> | undefined;
let windowPainted: Promise<void> = Promise.resolve();

function trusted(event: IpcMainEvent | IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
    || event.senderFrame.url.split('?')[0] !== pathToFileURL(page).href) throw new Error('IPC 来源无效');
}
function publish(report: ProbeReport): void {
  latest = report;
  if (window && !window.isDestroyed()) window.webContents.send('probe:report', report);
}
async function execute(value: unknown): Promise<void> {
  if (busy) throw new Error('已有验证正在进行');
  const input = validateInput(value);
  busy = true;
  controller = new AbortController();
  const deadline = setTimeout(() => controller?.abort(), 45000);
  try {
    await runProbe(input, controller.signal, publish, rendererReady);
    await mkdir(resolve(process.cwd(), 'artifacts'), { recursive: true });
    await writeFile(resolve(process.cwd(), 'artifacts/opend-probe.json'), JSON.stringify(latest, null, 2) + '\n', 'utf8');
  }
  finally { clearTimeout(deadline); busy = false; controller = undefined; input.key = ''; }
}
async function autoRun(): Promise<void> {
  try {
    await windowPainted;
    if (smoke || uiCheck) {
      const dom = await window!.webContents.executeJavaScript(`new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve({
          title: document.querySelector('h1')?.textContent,
          inputs: document.querySelectorAll('input').length,
          width: document.querySelector('main')?.getBoundingClientRect().width,
          height: document.querySelector('main')?.getBoundingClientRect().height,
          background: getComputedStyle(document.documentElement).backgroundColor
        })));
      })`);
      await mkdir(resolve(process.cwd(), 'artifacts'), { recursive: true });
      if (window) await writeFile(resolve(process.cwd(), 'artifacts/probe-ui.png'), (await window.webContents.capturePage()).toPNG());
      const visible = window!.isVisible();
      const minimized = window!.isMinimized();
      const passed = rendererReady && dom.title === '连接本机 OpenD' && dom.inputs === 4 && dom.width > 0 && dom.height > 0 && (!uiCheck || (visible && !minimized));
      const result = { smoke: passed ? 'passed' : 'failed', rendererReady, visible, minimized, dom, electron: process.versions.electron, node: process.versions.node };
      await writeFile(resolve(process.cwd(), 'artifacts/ui-check.json'), JSON.stringify(result, null, 2) + '\n');
      console.log(JSON.stringify(result));
      app.exit(passed ? 0 : 1); return;
    }
    const input = {
      host: process.env.OPEND_HOST || '127.0.0.1', port: Number(process.env.OPEND_WS_PORT || '33333'),
      ssl: process.env.OPEND_SSL === 'true', key: automaticKey,
      symbols: (process.env.OPEND_SYMBOLS || DEFAULT_SYMBOLS.join(',')).split(','),
      observeMs: Number(process.env.OPEND_OBSERVE_MS || '15000'),
    };
    automaticKey = '';
    try { await execute(input); } finally { input.key = ''; }
    const reportPath = resolve(process.cwd(), 'artifacts/opend-probe.json');
    console.log(JSON.stringify({ outcome: latest?.outcome, rendererReady, reportPath,
      checks: latest?.checks, symbols: latest?.symbols.map(item => ({ symbol: item.symbol, subscription: item.subscription, pushCount: item.pushCount })) }));
    app.exit(latest?.outcome === 'passed' ? 0 : 2);
  } catch (error) {
    console.error(error instanceof Error ? error.message : '验证启动失败'); app.exit(1);
  }
}

ipcMain.handle('probe:run', async (event, value: unknown) => {
  trusted(event);
  try { validateInput(value); if (busy) throw new Error('已有验证正在进行'); }
  catch (error) { return { ok: false, message: error instanceof Error ? error.message : '参数无效' }; }
  void execute(value).catch(() => undefined);
  return { ok: true };
});
ipcMain.handle('probe:cancel', event => { trusted(event); controller?.abort(); });
ipcMain.handle('probe:get', event => { trusted(event); return latest; });
ipcMain.on('probe:renderer-ready', event => {
  trusted(event);
  if (rendererReady) return;
  rendererReady = true;
  clearTimeout(readyTimer);
  if (automatic || smoke || uiCheck) void autoRun();
});

if (!app.requestSingleInstanceLock()) {
  if (automatic || smoke || uiCheck) { console.error('验证程序已有实例，请先关闭现有窗口再运行自动检查'); app.exit(1); }
  else app.quit();
}
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  void app.whenReady().then(async () => {
    app.setAppUserModelId('local.stock-bar.opend-probe');
    window = new BrowserWindow({
      width: 1160, height: 820, minWidth: 800, minHeight: 620, title: 'OpenD 接入验证',
      show: false, backgroundColor: '#10151f',
      webPreferences: { preload: join(__dirname, '../preload/index.js'), nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    windowPainted = new Promise(resolvePaint => {
      window!.once('ready-to-show', () => {
        if (!automatic && !smoke) window?.show();
        resolvePaint();
      });
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('did-fail-load', (_event, code, description) => console.error(`page load failed: ${code} ${description}`));
    window.webContents.on('render-process-gone', (_event, details) => console.error(`renderer exited: ${details.reason}`));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.on('closed', () => { controller?.abort(); window = undefined; });
    readyTimer = setTimeout(() => { console.error('React/preload 启动未完成'); if (automatic || smoke || uiCheck) app.exit(1); }, 12000);
    await window.loadFile(page, { query: { view: 'probe' } });
  }).catch(error => { console.error(error instanceof Error ? error.message : 'Electron 启动失败'); app.exit(1); });
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => controller?.abort());

