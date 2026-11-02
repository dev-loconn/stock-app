import { app, type BrowserWindow } from 'electron';
import { mkdir, readFile, rmdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { QuoteProvider } from './market-service';
import { SettingsStore } from './settings';
import { BAR_CHROME_WIDTH, type WatchItem } from '../shared/stock';

// Isolated native diagnostic, called only by the protocol-fixture layout suite.
export async function runBarSelectionCheck(settings: BrowserWindow, bar: BrowserWindow, overview: BrowserWindow, service: QuoteProvider) {
  const checks: string[] = [];
  const assert = (ok: boolean, label: string) => { if (!ok) throw Error(label); checks.push(label); };
  const evaluate = (window: BrowserWindow, script: string) => window.webContents.executeJavaScript(script);
  const until = async (predicate: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 12000;
    while (!await predicate()) { if (Date.now() > deadline) throw Error('展示选择验收超时'); await new Promise(done => setTimeout(done, 50)); }
  };
  const original = service.state(false).preferences;
  const saveList = async (items: WatchItem[]) => {
    const result = await evaluate(settings, `window.stockBar.setWatchlist(${JSON.stringify(items)})`);
    assert(result.ok, `save ${items.length} watchlist entries with explicit bar selection`);
    await until(() => evaluate(settings, `document.querySelector('.watchlist').getAttribute('aria-busy')==='false' && document.querySelectorAll('.watchlist li').length===${items.length}`));
  };
  const saveCapacity = async (value: number) => {
    const result = await evaluate(settings, `(async()=>{const s=await window.stockBar.get();return window.stockBar.saveAppearance({...s.preferences,barPageSize:${value}})})()`);
    assert(result.ok, `save page capacity ${value}`);
    await until(() => service.state(false).preferences.barPageSize === value);
  };
  const page = () => evaluate(bar, `document.querySelector('.page-number').textContent`);
  const wheel = async () => {
    await new Promise(done => setTimeout(done, 180));
    await evaluate(bar, `document.querySelector('.stock-bar').dispatchEvent(new WheelEvent('wheel',{deltaY:100,bubbles:true}))`);
  };
  const path = join(app.getPath('userData'), 'stock-bar-settings.json');
  const directory = resolve(process.env.STOCK_BAR_CHECK_OUTPUT || 'artifacts/layout-fixture');
  assert(original.watchlist.every(item => item.showInBar === true) && original.barPageSize === 3, 'legacy profile migrates all existing selections and defaults to three per page');
  // Exercise the actual React input and button, rather than only the IPC bridge.
  await evaluate(settings, `(()=>{const input=document.querySelector('[aria-label="悬浮条每页最多显示"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'2');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await evaluate(settings, `Array.from(document.querySelectorAll('button')).find(node=>node.textContent==='保存外观').click()`);
  await until(() => service.state(false).preferences.barPageSize === 2);
  await until(() => evaluate(bar, `document.querySelectorAll('.quote-tile').length===2`));
  assert(await page() === '1/5', 'appearance input saves two per page and resets the bar to page one');
  const selected = original.watchlist.map((item, index) => ({ ...item, showInBar: index < 5 }));
  const subscriptions = service.diagnostics().basicSubscriptions;
  await saveList(selected);
  await until(() => evaluate(bar, `document.querySelector('.page-number').textContent==='1/3'`));
  await wheel(); await wheel();
  await until(async () => await page() === '3/3');
  const bounds = bar.getBounds();
  assert(await evaluate(bar, `document.querySelectorAll('.quote-tile').length===1`) && Math.abs(bounds.width - (360 + BAR_CHROME_WIDTH)) <= 2,
    'only selected securities paginate, and the last page keeps two fixed-width slots');
  const control = process.env.STOCK_BAR_FIXTURE_CONTROL!;
  await fetch(control + '/push?price=147');
  await until(() => evaluate(overview, `Array.from(document.querySelectorAll('.overview-price')).every(node=>node.textContent==='147.00')`));
  assert(await page() === '3/3' && await evaluate(overview, `document.querySelectorAll('tbody tr').length===10`),
    'unselected securities still update in the full panel without resetting the current page');
  await evaluate(settings, `document.querySelectorAll('.bar-selection input')[5].click()`);
  await until(() => service.state(false).preferences.watchlist[5].showInBar === true);
  await until(async () => await page() === '1/3');
  assert(service.diagnostics().basicSubscriptions === subscriptions && service.state(false).connection === 'connected',
    'checkbox saves immediately, returns to page one and preserves existing subscriptions');
  await until(() => evaluate(settings, `document.querySelector('.watchlist').getAttribute('aria-busy')==='false'`));
  await evaluate(settings, `document.querySelectorAll('.bar-selection input')[5].click()`);
  await until(() => service.state(false).preferences.watchlist[5].showInBar === false);
  await until(async () => await page() === '1/3');
  assert(true, 'returning to a previous selection does not restore its former page');
  await wheel(); await saveCapacity(5);
  await until(async () => await page() === '1/1' && await evaluate(bar, `document.querySelectorAll('.quote-tile').length===5`));
  assert(Math.abs(bar.getBounds().width - (900 + BAR_CHROME_WIDTH)) <= 2, 'page capacity can exceed the former three-security limit');
  await saveList(selected.map((item, index) => ({ ...item, showInBar: index < 2 })));
  await until(() => Math.abs(bar.getBounds().width - (360 + BAR_CHROME_WIDTH)) <= 2);
  assert(true, 'fewer selections shrink the bar to the actual number, even with a larger configured capacity');
  const none = selected.map(item => ({ ...item, showInBar: false }));
  await saveList(none);
  await until(() => evaluate(bar, `document.querySelector('.empty-bar')?.textContent==='请选择展示证券' && !!document.querySelector('.overview-toggle')`));
  const restored = new SettingsStore(path, { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' });
  await restored.load(false);
  assert(restored.preferences.watchlist.length === 10 && restored.preferences.watchlist.every(item => item.showInBar === false)
    && restored.preferences.barPageSize === 5, 'fresh settings load preserves empty selection and the saved capacity');
  await saveList(selected);
  const blocked = path + '.tmp'; await mkdir(blocked);
  try {
    const result = await evaluate(settings, `window.stockBar.setWatchlist(${JSON.stringify(none)})`);
    assert(!result.ok && service.state(false).preferences.watchlist.filter(item => item.showInBar).length === 5,
      'failed selection save preserves the previous displayed selection');
    const appearance = await evaluate(settings, `(async()=>{const s=await window.stockBar.get();return window.stockBar.saveAppearance({...s.preferences,barPageSize:1})})()`);
    assert(!appearance.ok && service.state(false).preferences.barPageSize === 5, 'failed appearance save preserves the previous capacity');
    const disk = JSON.parse(await readFile(path, 'utf8'));
    assert(disk.preferences.barPageSize === 5 && disk.preferences.watchlist.filter((item: WatchItem) => item.showInBar).length === 5,
      'failed saves do not overwrite persisted appearance or selections');
  } finally { await rmdir(blocked); }
  const larger = [...selected, ...Array.from({ length: 4 }, (_, index) => ({ symbol: `HK.${String(index + 21).padStart(5, '0')}`, name: '更多自选', securityType: 3, showInBar: false }))];
  await until(() => service.state(false).connection === 'connected');
  await saveList(larger);
  await until(() => service.state(false).connection === 'connected');
  await until(() => evaluate(settings, `document.querySelector('.watchlist-count').textContent==='共 14 只，悬浮条展示 5 只'`));
  assert(await evaluate(settings, `document.querySelectorAll('.watchlist li').length===14 && document.querySelector('.watchlist-count').textContent==='共 14 只，悬浮条展示 5 只' && document.querySelector('.watchlist').scrollHeight>document.querySelector('.watchlist').clientHeight`),
    'more than ten securities remain manageable in a scrolling list with correct total and selected counts');
  const reloaded = new SettingsStore(path, { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' }); await reloaded.load(false);
  assert(reloaded.preferences.watchlist.length === 14, 'more than ten securities reload without truncation');
  await evaluate(settings, `document.querySelector('.watchlist').closest('section').scrollIntoView({block:'start'})`);
  settings.webContents.invalidate(); bar.webContents.invalidate();
  // Warm the hidden capturer before taking evidence so Chromium commits current DOM state.
  await settings.webContents.capturePage(); await bar.webContents.capturePage();
  await evaluate(settings, `new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))`);
  settings.webContents.invalidate(); bar.webContents.invalidate();
  await new Promise(done => setTimeout(done, 250));
  await writeFile(resolve(directory, 'bar-selection-settings.png'), (await settings.webContents.capturePage()).toPNG());
  await writeFile(resolve(directory, 'bar-selection.png'), (await bar.webContents.capturePage()).toPNG());
  await evaluate(settings, `(()=>{const input=document.querySelector('[aria-label="悬浮条每页最多显示"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'5');input.dispatchEvent(new Event('input',{bubbles:true}));input.closest('section').scrollIntoView({block:'start'});})()`);
  settings.webContents.invalidate(); await settings.webContents.capturePage();
  await evaluate(settings, `new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))`);
  settings.webContents.invalidate(); await new Promise(done => setTimeout(done, 200));
  await writeFile(resolve(directory, 'bar-selection-appearance.png'), (await settings.webContents.capturePage()).toPNG());
  await saveList(larger.slice(1));
  await until(() => service.state(false).connection === 'connected');
  const added = await evaluate(settings, `window.stockBar.add(${JSON.stringify(original.watchlist[0].symbol)})`);
  assert(added.ok && service.state(false).preferences.watchlist.at(-1)?.showInBar === false,
    'removing and re-adding a formerly selected security defaults to not showing it');
  await until(() => service.state(false).connection === 'connected');
  await saveCapacity(original.barPageSize);
  await saveList(original.watchlist);
  await until(() => service.state(false).connection === 'connected');
  return checks;
}
