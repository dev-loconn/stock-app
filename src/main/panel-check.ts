import { app, BrowserWindow, screen } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import type { MarketService } from './market-service';
import type { WatchlistPanel } from './watchlist-panel';
import type { BarVisibility } from './visibility';
import { panelBounds } from '../shared/panel-layout';

// Fixture-only native-window checks. No user's settings, credentials or connection are used.
export async function runPanelCheck(bar: BrowserWindow, service: MarketService, panel: WatchlistPanel,
  visibility: BarVisibility, getSettings: () => BrowserWindow | undefined) {
  const directory = resolve(process.env.STOCK_BAR_CHECK_OUTPUT || 'artifacts/panel-fixture');
  await mkdir(directory, { recursive: true });
  const checks: string[] = [];
  const limitations = ['Physical multi-monitor and exclusive fullscreen game not exercised', 'External application click-through requires separate interactive verification'];
  const assert = (condition: boolean, label: string) => { if (!condition) throw Error(label); checks.push(label); };
  const until = async (predicate: () => boolean | Promise<boolean>, label: string) => {
    const deadline = Date.now() + 12000;
    while (!await predicate()) { if (Date.now() > deadline) throw Error(`面板验收超时：${label}`); await new Promise(done => setTimeout(done, 40)); }
  };
  const evaluate = (window: BrowserWindow, script: string) => window.webContents.executeJavaScript(script);
  const control = process.env.STOCK_BAR_FIXTURE_CONTROL;
  if (!control || !/^http:\/\/127\.0\.0\.1:\d+$/.test(control)) throw Error('缺少面板夹具控制地址');
  const command = async (path: string) => { const response = await fetch(control + path); if (!response.ok) throw Error('面板夹具控制失败'); return response.json(); };
  const open = async () => {
    const window = panel.open()!;
    await until(async () => panel.isPresented() && window.isFocused() && !window.webContents.isLoading() && await evaluate(window, `document.querySelectorAll('tbody tr').length === ${service.state(false).rows.length}`), '面板就绪与键盘焦点');
    return window;
  };
  const screenshot = async (window: BrowserWindow, name: string) => {
    await new Promise(done => setTimeout(done, 100));
    await writeFile(resolve(directory, name), (await window.webContents.capturePage()).toPNG());
  };
  let passed = false;
  let failure: string | undefined;
  let clickFixture: ChildProcess | undefined;
  let fixtureOutput = '';
  try {
    await until(() => bar.isVisible() && service.state(false).rows.every(row => !!row.quote), '横条与全部报价');
    assert(!panel.isOpen(), 'startup is collapsed');
    const topmostAvailable = bar.isAlwaysOnTop();
    if (!topmostAvailable) limitations.push('Baseline bar HWND reports alwaysOnTop=false in this execution environment; topmost verification pending');
    const work = screen.getDisplayMatching(bar.getBounds()).workArea;
    bar.setPosition(work.x + 30, work.y + 30);
    panel.open(); panel.close();
    await new Promise(done => setTimeout(done, 350));
    assert(!panel.isPresented() && !panel.isOpen(), 'closing during initial preparation prevents a delayed reveal');
    if (process.env.STOCK_BAR_PANEL_FLASH_CHECK === '1') {
      const { checkPanelFlash } = await import('./panel-flash-check.js');
      await checkPanelFlash(bar, panel, directory);
      assert(true, 'eight openings keep a continuous dark panel surface in desktop frames');
    }
    const barWindows = BrowserWindow.getAllWindows().map(window => window.id);
    bar.webContents.sendInputEvent({ type: 'mouseMove', x: 80, y: 20 });
    await new Promise(done => setTimeout(done, 450));
    assert(BrowserWindow.getAllWindows().every(window => barWindows.includes(window.id)), 'hovering a bar quote does not create a detail window');
    assert(await evaluate(bar, `!('hover' in window.stockBar)`), 'production bridge no longer exposes hover details');
    await evaluate(bar, `document.querySelector('.overview-toggle').click()`);
    await until(() => panel.isPresented(), '箭头展开');
    const window = await open();
    const cornerFrame = await window.webContents.capturePage();
    const cornerPixels = cornerFrame.toBitmap();
    const cornerSize = cornerFrame.getSize();
    const alphaAt = (x: number, y: number) => cornerPixels[(y * cornerSize.width + x) * 4 + 3];
    assert(alphaAt(Math.floor(cornerSize.width / 2), Math.floor(cornerSize.height / 2)) === 255,
      'rounded panel content remains fully opaque');
    const nativeHandle = window.getNativeWindowHandle();
    const nativeStyle = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-File', resolve(__dirname, '../../scripts/inspect-window.ps1'),
      '-Handle', String(nativeHandle.readBigUInt64LE())], { windowsHide: true, encoding: 'utf8' }));
    await writeFile(resolve(directory, 'native-style.json'), JSON.stringify(nativeStyle, null, 2));
    assert(!nativeStyle.thickFrame && !nativeStyle.caption, 'panel has no native Windows frame or caption');
    assert([[0, 0], [cornerSize.width - 1, 0], [0, cornerSize.height - 1], [cornerSize.width - 1, cornerSize.height - 1]]
      .every(([x, y]) => alphaAt(x, y) < 5), 'all four rounded cutouts are transparent');
    assert(await evaluate(window, `document.activeElement !== document.querySelector('.overview-table-scroll')`), 'opening the panel does not draw a programmatic list focus ring');
    assert(!window.isResizable() && window.getParentWindow() === bar, 'fixed panel belongs to the bar');
    if (topmostAvailable) assert(window.isAlwaysOnTop() || bar.isAlwaysOnTop(), 'panel inherits the always-on-top bar ownership');
    assert(panel.open()!.id === window.id, 'repeated open reuses the same panel');
    await until(async () => await evaluate(bar, `document.querySelector('.overview-toggle').getAttribute('aria-expanded')==='true'`), '箭头状态');
    assert(await evaluate(window, `document.querySelectorAll('tbody tr').length===10 && !document.querySelector('h1, thead, .overview-note') && document.querySelectorAll('tbody tr:first-child > *').length===3`), 'ten securities use a compact three-column list without page chrome');
    assert(await evaluate(window, `document.querySelector('.overview-table-scroll').scrollHeight > document.querySelector('.overview-table-scroll').clientHeight`), 'list scrolls after six visible rows');
    console.log(JSON.stringify({ panelBounds: window.getBounds(), barBounds: bar.getBounds(), font: service.state(false).preferences.fontSize }));
    await screenshot(window, 'panel.png');
    assert(window.getBounds().height <= 330 && Math.abs(window.getBounds().width - bar.getBounds().width) <= 2, 'panel size follows the bar and caps at six rows (fractional DPI tolerance)');
    const before = await command('/stats');
    await screenshot(bar, 'bar.png'); await screenshot(window, 'panel.png');
    await evaluate(window, `document.querySelector('tbody tr').click()`);
    assert(panel.isOpen(), 'clicking a quote does not navigate or close');
    const panelWindows = BrowserWindow.getAllWindows().map(window => window.id);
    window.webContents.sendInputEvent({ type: 'mouseMove', x: 25, y: 60 });
    await new Promise(done => setTimeout(done, 450));
    assert(BrowserWindow.getAllWindows().every(window => panelWindows.includes(window.id)), 'hovering a panel row does not create a detail window');
    assert(panel.isPresented(), 'hovering a panel row keeps the panel open');
    window.webContents.sendInputEvent({ type: 'mouseLeave', x: 0, y: 0 });
    await new Promise(done => setTimeout(done, 80));
    assert(panel.isPresented(), 'mouse leave keeps the panel open');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await until(() => !panel.isPresented(), 'Esc 收起');
    assert(window.getOpacity() === 0 && !window.isFocusable(), 'collapsed panel is invisible and cannot take keyboard focus');
    await until(async () => await evaluate(window, `document.body.inert`), '收起内容退出交互与无障碍树');
    assert(!panel.isOpen(), 'Escape closes panel');
    await open();
    await evaluate(bar, `document.querySelector('.overview-toggle').click()`);
    await until(() => !panel.isPresented(), '箭头收起');
    assert(true, 'arrow toggles an open panel closed');
    await open();
    const position = bar.getBounds();
    bar.setPosition(position.x + 100, position.y + 70);
    await until(() => Math.abs(window.getBounds().x - bar.getBounds().x) <= 1, '跟随移动');
    assert(panel.isPresented() && Math.abs(window.getBounds().y - bar.getBounds().y - bar.getBounds().height) <= 1, 'moving bar keeps the panel attached below');
    bar.setPosition(work.x + work.width - position.width, work.y + work.height - position.height);
    await until(() => window.getBounds().y < bar.getBounds().y, '底部向上展开');
    assert(window.getBounds().x + window.getBounds().width <= work.x + work.width + 1, 'bottom and right edge stay inside the work area');
    await screenshot(window, 'panel-above.png');
    bar.setPosition(work.x + 30, work.y + 30);
    await command('/push?price=123');
    await until(async () => await evaluate(window, `Array.from(document.querySelectorAll('.overview-price')).every(node=>node.textContent==='123.00')`), '全部报价更新');
    assert(true, 'all ten panel rows update through the existing bridge');
    await command('/drop');
    await until(async () => await evaluate(window, `document.querySelector('.overview-connection strong').textContent==='重连中'`), '断线提示');
    assert(await evaluate(window, `Array.from(document.querySelectorAll('.overview-price')).every(node=>node.textContent==='123.00')`), 'disconnect retains this session prices with one connection status');
    await screenshot(window, 'panel-offline.png');
    await command('/restore');
    await until(() => service.state(false).connection === 'connected', '重连');
    const after = await command('/stats');
    assert(after.connections === before.connections + 1, 'only the intentional disconnection reconnects the quote provider');
    visibility.hide();
    assert(!panel.isPresented() && !panel.isOpen(), 'manual hide collapses panel');
    visibility.restore();
    assert(bar.isVisible() && !panel.isPresented(), 'restore leaves panel collapsed');
    visibility.hide(); await open();
    assert(bar.isVisible() && panel.isPresented() && !visibility.snapshot().manualHidden, 'explicit overview request restores a manually hidden bar');
    visibility.setSample({ monitor: '1', fullscreenMonitors: ['1'] });
    assert(!bar.isVisible() && !panel.isPresented() && !panel.isOpen(), 'fullscreen sample collapses both native windows');
    assert(panel.open() === undefined && !panel.isOpen(), 'overview request cannot override fullscreen hiding');
    visibility.setSample({ monitor: '1', fullscreenMonitors: [] });
    assert(bar.isVisible() && !panel.isPresented(), 'exiting fullscreen does not queue or reopen panel');
    await open();
    await evaluate(window, `Array.from(document.querySelectorAll('button')).find(node=>node.textContent==='管理自选').click()`);
    await until(() => !!getSettings()?.isVisible() && !getSettings()!.webContents.isLoading(), '管理入口');
    assert(!panel.isPresented(), 'manage opens settings and collapses panel');
    const settings = getSettings()!;
    const original = service.state(false).preferences.watchlist;
    const save = async (items: typeof original) => {
      const result = await evaluate(settings, `window.stockBar.setWatchlist(${JSON.stringify(items)})`);
      assert(result.ok, `save ${items.length} fixture securities`);
    };
    await save(original.slice(0, 1)); await open();
    const onePanel = panelBounds(bar.getBounds(), work, 1, 14);
    assert(window.getBounds().height < 100 && Math.abs(window.getBounds().width - onePanel.width) <= 2, 'one-security panel matches the bar width and content height');
    await screenshot(window, 'panel-one.png');
    const forbidden = await evaluate(window, `window.stockBar.setWatchlist([]).then(()=>false,()=>true)`);
    assert(forbidden, 'read-only panel cannot mutate watchlist through IPC');
    await save([]); await open();
    assert(await evaluate(window, `!!document.querySelector('.overview-empty button')`), 'empty panel keeps the add entry');
    await screenshot(window, 'panel-empty.png');
    await save(original); await open();
    const result = await evaluate(settings, `window.stockBar.saveAppearance({securityWidth:140,barPageSize:3,fontSize:20,opacity:0.4,autoStart:false})`);
    assert(result.ok, 'large-font appearance saves');
    await until(async () => await evaluate(window, `getComputedStyle(document.querySelector('.overview-page')).fontSize==='20px'`), '面板字号同步');
    assert(window.getOpacity() === 1 && bar.getOpacity() < 0.5, 'panel remains opaque while bar opacity changes');
    await screenshot(window, 'panel-large-font.png');
    // A different focused native window exercises the actual blur path, not a DOM blur event.
    settings.show(); settings.focus();
    await until(() => settings.isFocused() && !window.isFocused(), '其他原生窗口焦点');
    await new Promise(done => setTimeout(done, 220));
    assert(panel.isPresented() && panel.isOpen(), 'external focus keeps the panel open');
    const unfocusedPosition = bar.getBounds();
    bar.setPosition(unfocusedPosition.x + 1, unfocusedPosition.y);
    await new Promise(done => setTimeout(done, 180));
    assert(settings.isFocused(), 'external focus remains with the clicked destination');
    await evaluate(settings, `window.stockBar.openOverview()`);
    await until(() => panel.isPresented() && window.isFocused(), '设置页展开');
    assert(true, 'settings entry focuses the same already-open panel');
    const expected = panelBounds(bar.getBounds(), work, original.length, 20);
    assert(Math.abs(window.getBounds().height - expected.height) <= 2, 'font-size change recomputes native height');
    const rendererFailures: string[] = [];
    const rendererGone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) => rendererFailures.push(details.reason);
    window.webContents.on('render-process-gone', rendererGone);
    try {
      // Focus changes keep the panel open. Only an explicit button action closes
      // it; exercise that sequence repeatedly and inspect the rendered pixels.
      for (let index = 0; index < 20; index++) {
        settings.show(); settings.focus();
        await until(() => settings.isFocused() && !window.isFocused(), `external focus ${index}`);
        await new Promise(done => setTimeout(done, 180));
        assert(panel.isPresented() && panel.isOpen(), `blur ${index} keeps the panel open`);
        assert(settings.isFocused(), `blur ${index} leaves focus with the destination`);
        await evaluate(bar, `document.querySelector('.overview-toggle').click()`);
        await until(() => !panel.isPresented() && !panel.isOpen(), `button closes ${index}`);
        await open();
        const frame = await window.webContents.capturePage();
        const bitmap = frame.toBitmap();
        let light = 0;
        for (let offset = 0; offset < bitmap.length; offset += 4) {
          if (bitmap[offset] > 225 && bitmap[offset + 1] > 225 && bitmap[offset + 2] > 225) light++;
        }
        assert(bitmap.length > 0 && light / (bitmap.length / 4) < 0.05, `reopen ${index} paints the dark panel instead of a white surface`);
      }
      assert(rendererFailures.length === 0, 'capture-like focus changes do not terminate the panel renderer');
      await screenshot(window, 'panel-after-focus-cycles.png');
    } finally { window.webContents.removeListener('render-process-gone', rendererGone); }
    if (process.env.STOCK_BAR_PANEL_PREVIEW === '1') {
      await evaluate(settings, `window.stockBar.saveAppearance({securityWidth:180,barPageSize:3,fontSize:14,opacity:1,autoStart:false})`);
      settings.hide();
      clickFixture = spawn(process.execPath, [app.getAppPath(), '--panel-click-fixture'], { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
      clickFixture.stdout?.on('data', data => { fixtureOutput += data; });
      await open();
      await writeFile(resolve(directory, 'preview-ready.json'), JSON.stringify({ ready: true }));
      const deadline = Date.now() + 240000;
      while (Date.now() < deadline) {
        try { if (JSON.parse(await readFile(resolve(directory, 'preview-release.json'), 'utf8')).done) break; } catch {}
        await new Promise(done => setTimeout(done, 150));
      }
      await writeFile(resolve(directory, 'interactive-result.json'), JSON.stringify({ firstExternalClick: fixtureOutput.includes('fixture-click:1'),
        fixtureOutput, bar: bar.getBounds(), panel: window.getBounds(), panelOpen: panel.isOpen() }, null, 2));
    }
    passed = true;
  } catch (error) { failure = error instanceof Error ? error.message : String(error); throw error; }
  finally {
    clickFixture?.kill();
    const report = { passed, failure, capturedAt: new Date().toISOString(), appVersion: app.getVersion(),
      executable: process.execPath, mode: 'isolated protocol fixture; visible native Electron windows', checks,
      displays: screen.getAllDisplays().map(display => ({ bounds: display.bounds, scaleFactor: display.scaleFactor })),
      limitations };
    await writeFile(resolve(directory, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  }
}
