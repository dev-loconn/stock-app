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
    // Hidden windows can retain an older compositor frame despite current DOM state.
    window.webContents.invalidate();
    await window.webContents.capturePage();
    await evaluate(window, `new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))`);
    window.webContents.invalidate();
    await new Promise(done => setTimeout(done, 150));
    await writeFile(resolve(directory, name), (await window.webContents.capturePage()).toPNG());
  };
  const control = process.env.STOCK_BAR_FIXTURE_CONTROL;
  if (!control || !/^http:\/\/127\.0\.0\.1:\d+$/.test(control)) throw Error('缺少本地布局夹具控制地址');
  const command = async (path: string) => { const response = await fetch(control + path); if (!response.ok) throw Error('布局夹具控制失败'); };
  await until(() => service.state(false).connection === 'connected' && service.state(false).rows.every(row => Boolean(row.quote)), '全部夹具行情');
  await until(async () => await evaluate(bar, `document.querySelectorAll('.quote-tile').length === 3 && Array.from(document.querySelectorAll('.quote-line strong')).every(node=>node.textContent==='101.00')`), '每页三只及连接状态已绘制');
  const initialBounds = bar.getBounds();
  assert(await evaluate(bar, `!document.querySelector('.bar-group') && typeof window.stockBar.group==='undefined' && typeof window.stockBar.groupMenu==='undefined'`), 'bar has no group selector or group bridge');
  const tileWidths = await evaluate(bar, `Array.from(document.querySelectorAll('.quote-tile')).map(node => node.getBoundingClientRect().width)`);
  console.log(JSON.stringify({ initialBounds, tileWidths, viewport: await evaluate(bar, `({width:innerWidth, ratio:devicePixelRatio})`) }));
  // Windows rounds native bounds to physical pixels at fractional display scales.
  assert(tileWidths.every((width: number) => Math.abs(width - 180) < 1) && Math.abs(initialBounds.width - (3 * 180 + BAR_CHROME_WIDTH)) <= 2, 'default width is 180 per security, three per page');
  assert(await evaluate(bar, `!document.querySelector('.bar-brand, .connection-word, .connection-dot') && document.querySelector('.bar-quotes').getBoundingClientRect().left <= 2`), 'bar has no connection indicator or reserved left gutter');
  const overview = openOverview()!;
  await until(async () => !overview.webContents.isLoading() && await evaluate(overview, `document.querySelectorAll('tbody tr').length === 10`), '总览显示十只');
  const barPixels = (await bar.webContents.capturePage()).getSize();
  const panelPixels = (await overview.webContents.capturePage()).getSize();
  assert(Math.abs(barPixels.width-panelPixels.width)<=1, 'bar and panel visible widths match within one physical pixel');
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
  assert(await evaluate(bar, `!document.querySelector('.connection-word, .connection-dot') && !Array.from(document.querySelectorAll('.market-tag')).some(node=>node.textContent.includes('重连'))`) &&
    await evaluate(overview, `Array.from(document.querySelectorAll('.overview-price')).every(node=>node.textContent==='123.00')`), 'outage status remains in overview and retains prices without adding bar chrome');
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
    assert(result.ok, `save watchlist of ${items.length} securities${result.message ? ': ' + result.message : ''}`);
  };
  await saveList(originalList.slice(0, 2));
  await until(async () => Math.abs(bar.getBounds().width - (2 * 180 + BAR_CHROME_WIDTH)) <= 2 && await evaluate(overview, `document.querySelectorAll('tbody tr').length === 2`), '删除后布局同步');
  assert(true, 'watchlist changes update overview and automatically resize the bar');
  await saveList([]);
  await until(async () => await evaluate(overview, `!!document.querySelector('.overview-empty')`) && await evaluate(bar, `!!document.querySelector('.empty-bar')`), '空自选入口');
  await screenshot(overview, 'overview-empty.png');
  await saveList(originalList);
  await until(async () => await evaluate(overview, `document.querySelectorAll('tbody tr').length === 10`), '恢复自选');
  // Exercise real React rendering through verified fixture securities, without changing their names.
  const displaySymbols = ['US.SOXL', 'US.SOXS', 'US.TQQQ', 'US.DISPLAYTEST', 'US.DISPLAYPLAIN', 'HK.09999'];
  await until(() => service.state(false).connection === 'connected', '核验前恢复夹具连接');
  await saveList(displaySymbols.map(symbol => ({ symbol, name: 'must be replaced by verified fixture metadata', securityType: 4, showInBar: true })));
  await until(() => service.state(false).rows.length === 6 && service.state(false).rows.every(row => Boolean(row.quote)), '代码显示夹具行情');
  await until(() => evaluate(bar, `JSON.stringify(Array.from(document.querySelectorAll('.stock-name')).map(node=>node.textContent))==='["SOXL","SOXS","TQQQ"]'`), 'ETF 代码标题');
  assert(await evaluate(bar, `!document.querySelector('.stock-name[title]')`), 'ETF ticker titles add no hover tooltip');
  await until(() => evaluate(overview, `document.querySelectorAll('tbody tr').length===6 && document.querySelector('tbody tr[data-symbol="US.SOXS"] .overview-name').textContent==='不含方向特征的测试名称'`), '面板保留证券名称');
  assert(await evaluate(settings, `document.querySelector('.watchlist li[data-symbol="US.SOXL"]').textContent.includes('三倍做多半导体测试')`), 'settings retain the verified security name while the bar shows its ticker');
  await command('/push?price=80.793&symbols=' + displaySymbols.join(','));
  await until(() => evaluate(bar, `Array.from(document.querySelectorAll('.quote-line strong')).every(node=>node.textContent==='80.79')`), '悬浮条两位小数');
  await until(() => evaluate(overview, `Array.from(document.querySelectorAll('.overview-price')).every(node=>node.textContent==='80.79')`), '面板两位小数');
  assert(service.state(false).rows.every(row => row.quote?.price === 80.793), 'both views round to two decimals while retaining the original quote price');
  assert(true, 'SOXL, SOXS and TQQQ render as tickers even when translated names lack directional keywords');
  await screenshot(bar, 'etf-tickers.png');
  await screenshot(overview, 'etf-names-panel.png');
  await new Promise(done => setTimeout(done, 180));
  await evaluate(bar, `document.querySelector('.stock-bar').dispatchEvent(new WheelEvent('wheel',{deltaY:100,bubbles:true}))`);
  await until(() => evaluate(bar, `JSON.stringify(Array.from(document.querySelectorAll('.stock-name')).map(node=>node.textContent))==='["DISPLAYTEST","普通指数基金测试","三倍做多港股测试"]'`), '名称识别与适用范围');
  assert(true, 'other US directional ETFs use tickers while ordinary ETFs and HK ETFs retain their names');
  await screenshot(bar, 'etf-name-rules.png');
  await new Promise(done => setTimeout(done, 180));
  await evaluate(bar, `document.querySelector('.stock-bar').dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true}))`);
  await until(() => evaluate(bar, `document.querySelector('.stock-name').textContent==='SOXL'`), '代码页恢复');
  await saveAppearance(140, 20);
  assert(await evaluate(bar, `Array.from(document.querySelectorAll('.stock-name')).every(node=>node.scrollWidth<=node.clientWidth+1) && document.querySelector('.bar-tools').getBoundingClientRect().right<=innerWidth+1`), 'short ETF tickers fit at 140px with the largest font and usable controls');
  await screenshot(bar, 'etf-tickers-narrow.png');
  // Switch using the real panel controls and IPC, keeping quote subscriptions intact.
  for (const [market, expected] of [['HK', 1], ['US', 5], ['all', 6]] as const) {
    await evaluate(overview, `Array.from(document.querySelectorAll('.overview-markets button')).find(node=>node.textContent===${JSON.stringify(market === 'HK' ? '港股' : market === 'US' ? '美股' : '全部')}).click()`);
    await until(() => evaluate(overview, `document.querySelectorAll('tbody tr').length===${expected}`), '市场面板筛选');
    await until(() => evaluate(bar, `document.querySelector('.page-number').textContent.startsWith('1/')`), '市场切换重置分页');
    const snapshot = await evaluate(overview, 'window.stockBar.get()');
    assert(snapshot.preferences.watchMarket === market && snapshot.rows.length === 6, 'market switch persists selection without dropping subscriptions: ' + market);
    assert(await evaluate(bar, `!document.querySelector('.overview-markets')`), 'market controls stay outside the floating bar');
  }
  await screenshot(overview, 'market-tabs.png');
  assert(await evaluate(bar, `!document.querySelector('.grip') && !document.querySelector('[aria-label="打开设置"]') && document.querySelectorAll('.bar-tools button').length===1`), 'bar removes drag grip and settings button while retaining panel toggle');
  const dragOrigin = bar.getBounds();
  bar.webContents.sendInputEvent({ type: 'mouseDown', x: 80, y: 12, globalX: 100, globalY: 100, button: 'left', clickCount: 1 });
  await new Promise(done => setTimeout(done, 100));
  bar.webContents.sendInputEvent({ type: 'mouseMove', x: 110, y: 22, globalX: 130, globalY: 110, modifiers: ['leftbuttondown'], button: 'left' });
  await new Promise(done => setTimeout(done, 300));
  await until(() => Math.abs(bar.getBounds().x - dragOrigin.x - 30) <= 2 && Math.abs(bar.getBounds().y - dragOrigin.y - 10) <= 2, '行情区域直接拖动');
  bar.webContents.sendInputEvent({ type: 'mouseUp', x: 80, y: 12, globalX: 130, globalY: 110, button: 'left', clickCount: 1 });
  await new Promise(done => setTimeout(done, 100));
  const dragEnd = bar.getBounds();
  bar.webContents.sendInputEvent({ type: 'mouseMove', x: 150, y: 25 });
  await new Promise(done => setTimeout(done, 100));
  assert(JSON.stringify(bar.getBounds()) === JSON.stringify(dragEnd), 'releasing the pointer stops dragging');
  assert(!bar.isFocusable(), 'dragging keeps the bar non-focusable');
  bar.setBounds(dragOrigin);
  await screenshot(bar, 'whole-bar-drag.png');
  await saveAppearance(140, 20);
  const repeatOrigin = bar.getBounds();
  await evaluate(bar, `window.stockBar.dragBar('start', {x:100,y:100})`);
  for (let step = 0; step < 120; step++) {
    await evaluate(bar, `window.stockBar.dragBar('move', {x:${100 + step % 20}, y:${100 + step % 10}})`);
    await new Promise(done => setTimeout(done, 5));
  }
  await evaluate(bar, `window.stockBar.dragBar('end', {x:100,y:100})`);
  const repeatEnd = bar.getBounds();

  assert(Math.abs(repeatEnd.width-repeatOrigin.width)<=1 && Math.abs(repeatEnd.height-repeatOrigin.height)<=1, '120 drag updates preserve window width and height without cumulative growth');
  for (let gesture = 0; gesture < 30; gesture++) {
    await evaluate(bar, `window.stockBar.dragBar('start', {x:100,y:100}); window.stockBar.dragBar('move', {x:110,y:110}); window.stockBar.dragBar('end', {x:110,y:110});`);
    await new Promise(done => setTimeout(done, 5));
    const bounds = bar.getBounds();
    assert(Math.abs(bounds.width-repeatOrigin.width)<=1 && Math.abs(bounds.height-repeatOrigin.height)<=1, 'separate drag preserves configured dimensions: ' + gesture);
  }
  bar.setBounds({x:repeatOrigin.x,y:repeatOrigin.y,width:450,height:60});
  for (const capacity of [1, 2, 3]) {
    await evaluate(settings, `(async()=>{const {preferences:p}=await window.stockBar.get();return window.stockBar.saveAppearance({...p,barPageSize:${capacity},securityWidth:140,fontSize:14})})()`);
    await new Promise(done => setTimeout(done, 150));
    const barWidthPixels = (await bar.webContents.capturePage()).getSize().width;
    const panelWidthPixels = (await overview.webContents.capturePage()).getSize().width;
    assert(Math.abs(barWidthPixels-panelWidthPixels)<=1, `visible widths match at page capacity ${capacity}: ${barWidthPixels}/${panelWidthPixels}`);
  }
  const managed = ['US.SOXL', 'HK.09999', 'US.SOXS', 'US.TQQQ'];
  await saveList(managed.map(symbol => ({symbol,name:symbol,securityType:4,showInBar:true})));
  await evaluate(settings, `Array.from(document.querySelectorAll('.watchlist-markets button')).find(node=>node.textContent==='美股').click()`);
  await until(() => evaluate(settings, `document.querySelectorAll('.watchlist li').length===3`), '设置美股分组');
  await evaluate(settings, `document.querySelector('.watchlist li[data-symbol="US.TQQQ"] .move-first').click()`);
  await until(() => evaluate(settings, `document.querySelector('.watchlist li').dataset.symbol==='US.TQQQ' && document.querySelector('.watchlist').getAttribute('aria-busy')==='false'`), '分组移到最前');
  const managedState = await evaluate(settings, 'window.stockBar.get()');
  assert(JSON.stringify(managedState.preferences.watchlist.map((item: {symbol:string})=>item.symbol)) === JSON.stringify(['US.TQQQ','HK.09999','US.SOXL','US.SOXS']), 'move-first updates only US slots and retains hidden HK security');
  assert(managedState.preferences.watchMarket === 'all', 'settings filter does not change floating bar market');
  assert(await evaluate(settings, `document.querySelector('.watchlist li .move-first').disabled`), 'first security disables redundant move-first');
  await evaluate(settings, `document.querySelector('.watchlist li[data-symbol="US.SOXL"] input').click()`);
  await until(() => evaluate(settings, `!document.querySelector('.watchlist li[data-symbol="US.SOXL"] input').checked && document.querySelector('.watchlist').getAttribute('aria-busy')==='false'`), '分组展示勾选');
  await evaluate(settings, `document.querySelector('.watchlist li[data-symbol="US.SOXS"] .remove').click()`);
  await evaluate(settings, `Array.from(document.querySelectorAll('.watchlist-confirm button')).find(node=>node.textContent==='确认移除').click()`);
  await until(() => evaluate(settings, `document.querySelectorAll('.watchlist li').length===2`), '分组移除');
  const afterManage = await evaluate(settings, 'window.stockBar.get()');
  assert(afterManage.preferences.watchlist.some((item: {symbol:string})=>item.symbol==='HK.09999') && afterManage.preferences.watchlist.length===3, 'filtered removal preserves hidden markets');
  await evaluate(settings, `document.querySelector('.watchlist-markets').scrollIntoView({block:'start'})`);
  await screenshot(settings, 'settings-market-order.png');
  const report = { passed: true, appVersion: app.getVersion(), executable: process.execPath,
    mode: 'protocol fixture only; isolated profile; hidden native Electron windows', checks };
  await writeFile(resolve(directory, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
