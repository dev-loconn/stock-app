import { app, type BrowserWindow } from 'electron';
import { mkdir, readFile, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { WatchItem } from '../shared/stock';

// Runs only inside the isolated, protocol-fixture layout diagnostic.
export async function runWatchlistCheck(settings: BrowserWindow, bar: BrowserWindow, overview: BrowserWindow) {
  const checks: string[] = [];
  const evaluate = (script: string) => settings.webContents.executeJavaScript(script);
  const assert = (condition: boolean, label: string) => { if (!condition) throw Error(label); checks.push(label); };
  const until = async (predicate: () => Promise<boolean>) => {
    const deadline = Date.now() + 10000;
    while (!await predicate()) { if (Date.now() > deadline) throw Error('自选拖拽检查超时'); await new Promise(done => setTimeout(done, 50)); }
  };
  const original: WatchItem[] = await evaluate(`window.stockBar.get().then(s=>s.preferences.watchlist)`);
  const symbols = (items: WatchItem[]) => items.map(item => item.symbol);
  const sameOrder = (actual: unknown, items: WatchItem[]) => JSON.stringify(actual) === JSON.stringify(symbols(items));
  const uiOrder = () => evaluate(`Array.from(document.querySelectorAll('.watchlist li')).map(node=>node.dataset.symbol)`);
  const begin = (symbol: string) => evaluate(`(()=>{
    const row=Array.from(document.querySelectorAll('.watchlist li')).find(node=>node.dataset.symbol===${JSON.stringify(symbol)});
    window.__watchlistDrag=new DataTransfer();
    row.querySelector('.watchlist-drag-handle').dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:window.__watchlistDrag}));
  })()`);
  const at = (symbol: string, edge: 'before' | 'after', type = 'dragover') => evaluate(`(()=>{
    const row=Array.from(document.querySelectorAll('.watchlist li')).find(node=>node.dataset.symbol===${JSON.stringify(symbol)});
    row.scrollIntoView({block:'center'});const rect=row.getBoundingClientRect();
    row.dispatchEvent(new DragEvent(${JSON.stringify(type)},{bubbles:true,cancelable:true,dataTransfer:window.__watchlistDrag,clientY:rect.top+rect.height*${edge === 'before' ? 0.25 : 0.75}}));
  })()`);
  const end = () => evaluate(`document.querySelector('.watchlist-drag-handle').dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:window.__watchlistDrag}))`);
  const waitOrder = async (items: WatchItem[]) => until(async () => sameOrder(await uiOrder(), items) &&
    await evaluate(`document.querySelector('.watchlist').getAttribute('aria-busy')==='false'`));
  await waitOrder(original);
  assert(await evaluate(`document.querySelectorAll('.watchlist-drag-handle[draggable="true"]').length===10 && !document.querySelector('[aria-label^="上移"], [aria-label^="下移"]')`), 'ten drag handles replace all arrow buttons');
  await begin(original[0].symbol); await at(original[2].symbol, 'after');
  assert(await evaluate(`!!document.querySelector('.drop-after') && !!document.querySelector('.is-dragging')`) && sameOrder(await uiOrder(), original), 'drag previews insertion without changing the saved order');
  await end();
  assert(await evaluate(`!document.querySelector('.drop-after, .drop-before, .is-dragging')`) && sameOrder(await uiOrder(), original), 'cancelled drag clears indicators and preserves order');

  const moved = [original[1], original[2], original[0], ...original.slice(3)];
  await begin(original[0].symbol); await at(original[2].symbol, 'after'); await at(original[2].symbol, 'after', 'drop'); await end();
  await waitOrder(moved);
  await until(async () => sameOrder(await overview.webContents.executeJavaScript(`Array.from(document.querySelectorAll('tbody tr')).map(node=>node.dataset.symbol)`), moved));
  const saved = JSON.parse(await readFile(join(app.getPath('userData'), 'stock-bar-settings.json'), 'utf8'));
  assert(JSON.stringify(saved.preferences.watchlist) === JSON.stringify(moved), 'downward drag persists watchlist metadata, order and display selection');
  assert(sameOrder(await evaluate(`window.stockBar.get().then(state=>state.preferences.watchlist.map(row=>row.symbol))`), moved), 'overview follows the reordered watchlist');
  await until(async () => JSON.stringify(await bar.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.stock-name')).map(node=>node.textContent)`)) === JSON.stringify(moved.slice(0, 3).map(item => item.name)));
  assert(true, 'bar pagination reflects the new watchlist order');

  // Force a write failure in the isolated profile and verify that neither UI nor disk changes.
  const blockedTemp = join(app.getPath('userData'), 'stock-bar-settings.json.tmp');
  await mkdir(blockedTemp);
  try {
    await begin(original[0].symbol); await at(original[1].symbol, 'before', 'drop'); await end();
    await until(async () => await evaluate(`document.querySelector('.watchlist').getAttribute('aria-busy')==='false' && !!document.querySelector('.operation-message') && !document.querySelector('.operation-message').textContent.includes('已保存')`));
    assert(sameOrder(await uiOrder(), moved) && sameOrder(await evaluate(`window.stockBar.get().then(state=>state.preferences.watchlist.map(item=>item.symbol))`), moved), 'failed save reports an error and retains the previous order');
  } finally { await rmdir(blockedTemp); }
  await begin(original[0].symbol); await at(original[1].symbol, 'before', 'drop'); await end();
  await waitOrder(original);
  assert(true, 'upward drag succeeds after a failed save and restores the original order');
  return checks;
}
