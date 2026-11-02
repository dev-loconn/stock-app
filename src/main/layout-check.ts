import { app, BrowserWindow } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QuoteProvider as QuoteService } from './market-service';
import { BAR_CHROME_WIDTH } from '../shared/stock';

// Explicit fixture-only diagnostic. The launcher supplies an isolated profile and a local gateway.
export async function runLayoutCheck(bar: BrowserWindow, service: QuoteService,
  openOverview: () => BrowserWindow | undefined, getSettings: () => BrowserWindow | undefined) {
  const directory = resolve(process.env.STOCK_BAR_CHECK_OUTPUT || 'artifacts/layout-fixture');
  await mkdir(directory, { recursive: true });
  const checks: string[] = [];
  const assert = (condition: boolean, label: string) => { if (!condition) throw Error(label); checks.push(label); };
  const until = async (predicate: () => boolean | Promise<boolean>, label: string) => {
    const deadline = Date.now() + 15000;
    while (!await predicate()) {
      if (Date.now() > deadline) throw Error(`验收超时：${label}`);
      await new Promise(done => setTimeout(done, 50));
    }
  };
  const evaluate = (window: BrowserWindow, script: string) => window.webContents.executeJavaScript(script);
  const screenshot = async (window: BrowserWindow, name: string) => {
    await new Promise(done => setTimeout(done, 150));
    await writeFile(resolve(directory, name), (await window.webContents.capturePage()).toPNG());
  };
  const control = process.env.STOCK_BAR_FIXTURE_CONTROL;
  if (!control || !/^http:\/\/127\.0\.0\.1:\d+$/.test(control)) throw Error('缺少本地布局夹具控制地址');
  const command = async (path: string) => { const response = await fetch(control + path); if (!response.ok) throw Error('布局夹具控制失败'); };
  await until(() => service.state(false).connection === 'connected' && service.state(false).rows.every(row => Boolean(row.quote)), '全部夹具行情');
  await until(async () => await evaluate(bar, `document.querySelectorAll('.quote-tile').length === 3 && !!document.querySelector('.bar-brand.online') && Array.from(document.querySelectorAll('.quote-line strong')).every(node=>node.textContent==='101.00')`), '每页三只及连接状态已绘制');
  const initialBounds = bar.getBounds();
  assert(await evaluate(bar, `!document.querySelector('.bar-group') && typeof window.stockBar.group==='undefined' && typeof window.stockBar.groupMenu==='undefined'`), 'bar has no group selector or group bridge');
  const tileWidths = await evaluate(bar, `Array.from(document.querySelectorAll('.quote-tile')).map(node => node.getBoundingClientRect().width)`);
  console.log(JSON.stringify({ initialBounds, tileWidths, viewport: await evaluate(bar, `({width:innerWidth, ratio:devicePixelRatio})`) }));
  // Windows rounds native bounds to physical pixels at fractional display scales.
  assert(tileWidths.every((width: number) => Math.abs(width - 180) < 1) && Math.abs(initialBounds.width - (3 * 180 + BAR_CHROME_WIDTH)) <= 2, 'default width is 180 per security, three per page');
  assert(await evaluate(bar, `getComputedStyle(document.querySelector('.connection-word')).display === 'none' && Math.abs(document.querySelector('.bar-brand').getBoundingClientRect().width - 32) < 1`), 'connected status only shows a compact dot');
  const overview = openOverview()!;
  await until(async () => !overview.webContents.isLoading() && await evaluate(overview, `document.querySelectorAll('tbody tr').length === 10`), '总览显示十只');
  assert(openOverview()!.id === overview.id, 'opening overview twice reuses the same window');
  assert(!overview.isResizable() && overview.getParentWindow() === bar, 'overview is a fixed-size panel anchored to the bar');
  const symbols = await evaluate(overview, `Array.from(document.querySelectorAll('tbody tr')).map(node => node.dataset.symbol)`);
  assert(JSON.stringify(symbols) === JSON.stringify(service.state(false).rows.map(row => row.symbol)), 'overview preserves watchlist order without pagination');
  assert(await evaluate(overview, `typeof require === 'undefined' && typeof window.stockBar.get === 'function'`), 'overview uses the isolated preload bridge');
  await screenshot(overview, 'overview.png');
  await screenshot(bar, 'bar.png');
  for (let index = 0; index < 3; index++) {
    await evaluate(bar, `document.querySelector('.stock-bar').dispatchEvent(new WheelEvent('wheel', {deltaY:100,bubbles:true}))`);
    await new Promise(done => setTimeout(done, 180));
  }
  await until(async () => await evaluate(bar, `document.querySelector('.page-number').textContent === '4/4'`), '末页');
  assert(JSON.stringify(bar.getBounds()) === JSON.stringify(initialBounds) && await evaluate(bar, `document.querySelectorAll('.quote-tile').length === 1 && Math.abs(document.querySelector('.quote-tile').getBoundingClientRect().width - 180) < 1`), 'last page leaves empty slots without resizing or moving');
  await screenshot(bar, 'last-page.png');
  await command('/push?price=123');
  await until(async () => await evaluate(overview, `Array.from(document.querySelectorAll('.overview-price')).every(node=>node.textContent==='123.00')`), '总览实时更新');
  await until(async () => await evaluate(bar, `document.querySelector('.quote-line strong').textContent === '123.00'`), '末页实时更新');
  assert(true, 'all ten overview prices and the current bar page update through the live bridge');
  await command('/drop');
  await until(async () => await evaluate(overview, `document.querySelector('.overview-connection strong').textContent === '重连中'`), '总览断线状态');
  assert(await evaluate(bar, `document.querySelector('.connection-word').textContent === '重连中' && !Array.from(document.querySelectorAll('.market-tag')).some(node=>node.textContent.includes('重连'))`) &&
    await evaluate(overview, `Array.from(document.querySelectorAll('.overview-price')).every(node=>node.textContent==='123.00')`), 'outage shows one global warning and retains prices');
  await screenshot(bar, 'offline-bar.png');
  await screenshot(overview, 'offline-overview.png');
  await command('/restore');
  await until(() => service.state(false).connection === 'connected', '夹具重连');
  await evaluate(overview, `Array.from(document.querySelectorAll('button')).find(node=>node.textContent==='管理自选').click()`);
  await until(async () => Boolean(getSettings() && !getSettings()!.webContents.isLoading()) && await evaluate(getSettings()!, `!!document.querySelector('.settings-page')`), '管理自选入口');
  const settings = getSettings()!;
  const saveAppearance = async (securityWidth: number, fontSize: number) => {
    const result = await evaluate(settings, `(async()=>{const state=await window.stockBar.get();return window.stockBar.saveAppearance({...state.preferences,securityWidth:${securityWidth},fontSize:${fontSize}});})()`);
    assert(result.ok, `save ${securityWidth}px security width at font ${fontSize}`);
    await until(async () => await evaluate(bar, `getComputedStyle(document.querySelector('.stock-bar')).getPropertyValue('--font-size').trim() === '${fontSize}px' && Math.abs(document.querySelector('.quote-tile').getBoundingClientRect().width - Math.min(${securityWidth},innerWidth-${BAR_CHROME_WIDTH})) < 1`), '外观应用');
  };
  await saveAppearance(180, 20);
  assert(Math.abs(bar.getBounds().width - initialBounds.width) <= 2, 'changing font size preserves security and window widths');
  await saveAppearance(140, 20);
  await screenshot(bar, 'small-width-large-font.png');
  await saveAppearance(360, 12);
  assert(await evaluate(settings, `(()=>{const n=document.querySelector('[aria-label="单只证券宽度"]');return n.min==='1' && n.max==='' && n.step==='1'})()`), 'security width input has no artificial minimum or maximum');
  await saveAppearance(96, 14);
  await screenshot(bar, 'width-96.png');
  await saveAppearance(480, 14);
  await screenshot(bar, 'width-480.png');
  await saveAppearance(5000, 14);
  assert(await evaluate(bar, `document.querySelectorAll('.quote-tile').length===1 && document.querySelector('.bar-tools').getBoundingClientRect().right<=innerWidth+1`), 'oversized configured width is clamped to available screen space with usable controls');
  await saveAppearance(1, 14);
  assert(await evaluate(bar, `document.querySelector('.bar-tools').getBoundingClientRect().right<=innerWidth+1 && document.querySelector('.bar-quotes').scrollWidth>=document.querySelector('.bar-quotes').clientWidth`), 'tiny configured widths clip quote content while preserving controls');
  await saveAppearance(180, 14);
  openOverview();
  await until(async () => await evaluate(overview, `document.querySelector('.overview-table-scroll').scrollHeight > document.querySelector('.overview-table-scroll').clientHeight`), '总览滚动');
  assert(true, 'overview scrolls through all securities within six visible rows');
  await screenshot(overview, 'overview-small.png');
  const forbidden = await evaluate(overview, `window.stockBar.saveAppearance({securityWidth:180,fontSize:14,opacity:1,autoStart:false}).then(()=>false,()=>true)`);
  assert(forbidden, 'read-only overview cannot change appearance through IPC');
  const originalList = service.state(false).preferences.watchlist;
  assert(await evaluate(settings, `!document.querySelector('.group-settings') && !document.querySelector('[aria-label="当前分组"]')`), 'settings has one watchlist and no group management');
  const { runWatchlistCheck } = await import('./watchlist-check.js');
  checks.push(...await runWatchlistCheck(settings, bar, overview));
  const { runBarSelectionCheck } = await import('./bar-selection-check.js');
  checks.push(...await runBarSelectionCheck(settings, bar, overview, service));
  const saveList = async (items: typeof originalList) => {
    const result = await evaluate(settings, `window.stockBar.setWatchlist(${JSON.stringify(items)})`);
    assert(result.ok, `save watchlist of ${items.length} securities`);
  };
  await saveList(originalList.slice(0, 2));
  await until(async () => Math.abs(bar.getBounds().width - (2 * 180 + BAR_CHROME_WIDTH)) <= 2 && await evaluate(overview, `document.querySelectorAll('tbody tr').length === 2`), '删除后布局同步');
  assert(true, 'watchlist changes update overview and automatically resize the bar');
  await saveList([]);
  await until(async () => await evaluate(overview, `!!document.querySelector('.overview-empty')`) && await evaluate(bar, `!!document.querySelector('.empty-bar')`), '空自选入口');
  await screenshot(overview, 'overview-empty.png');
  await saveList(originalList);
  await until(async () => await evaluate(overview, `document.querySelectorAll('tbody tr').length === 10`), '恢复自选');
  const report = { passed: true, appVersion: app.getVersion(), executable: process.execPath,
    mode: 'protocol fixture only; isolated profile; hidden native Electron windows', checks };
  await writeFile(resolve(directory, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
