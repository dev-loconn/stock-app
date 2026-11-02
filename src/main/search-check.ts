import { app, type BrowserWindow } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QuoteProvider as QuoteService } from './market-service';
import type { SecurityCatalog } from './security-catalog';

// Explicit protocol-fixture diagnostic, always using an isolated profile and hidden windows.
export async function runSearchCheck(bar: BrowserWindow, service: QuoteService, getSettings: () => BrowserWindow | undefined) {
  const directory = resolve(process.env.STOCK_BAR_CHECK_OUTPUT || 'artifacts/search-fixture');
  const control = process.env.STOCK_BAR_FIXTURE_CONTROL;
  if (!control || !/^http:\/\/127\.0\.0\.1:\d+$/.test(control)) throw Error('缺少本地搜索夹具控制地址');
  await mkdir(directory, { recursive: true });
  const checks: string[] = [];
  const assert = (condition: boolean, label: string) => { if (!condition) throw Error(label); checks.push(label); };
  const until = async (predicate: () => boolean | Promise<boolean>, label: string) => {
    const deadline = Date.now() + 20000;
    while (!await predicate()) { if (Date.now() > deadline) throw Error('验收超时：' + label); await new Promise(done => setTimeout(done, 50)); }
  };
  const evaluate = (script: string) => getSettings()!.webContents.executeJavaScript(script);
  const command = async (path: string) => { if (!(await fetch(control + path)).ok) throw Error('夹具控制失败'); };
  await until(() => Boolean(getSettings() && !getSettings()!.webContents.isLoading()), '设置页加载');
  await until(async () => await evaluate(`(async()=>{const s=await window.stockBar.get();return s.connection==='connected'&&s.directory.markets.every(m=>m.count>0&&!m.refreshing)})()`), '目录加载');
  assert(await evaluate(`typeof window.stockBar.connect==='function' && typeof window.stockBar.search==='function' && typeof window.stockBar.add==='function'`), 'production preload exposes connect, search and add');
  await evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='应用并连接').click()`);
  await until(async () => await evaluate(`document.querySelector('.operation-message')?.textContent.includes('已应用连接设置')`), '连接按钮调用正式 IPC');
  assert(await evaluate(`!document.querySelector('.operation-message').textContent.includes('is not a function')`), 'Apply and Connect reaches the main process without a missing-method error');
  const query = async (text: string) => {
    await evaluate(`(()=>{const input=document.getElementById('security-query');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await new Promise(done => setTimeout(done, 240));
    await until(async () => await evaluate(`!document.querySelector('.search-feedback').textContent.includes('正在') && document.getElementById('security-query').value === ${JSON.stringify(text)}`), '搜索完成');
  };
  const symbols = () => evaluate(`Array.from(document.querySelectorAll('.search-results li')).map(node=>node.dataset.symbol)`);
  const keyboard = (key: string, composing = false) => evaluate(`document.getElementById('security-query').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,isComposing:${composing}}))`);
  const capture = async (name: string) => {
    await evaluate(`document.querySelector('.security-search').scrollIntoView({block:'start'})`);
    await evaluate(`new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))`);
    await writeFile(resolve(directory, name), (await getSettings()!.webContents.capturePage()).toPNG());
  };
  assert(await evaluate(`document.querySelector('.search-feedback').textContent.includes('输入代码') && !document.querySelectorAll('.search-results li').length`), 'empty input only shows guidance');
  for (const text of ['700', '腾讯', '騰訊', 'Tencent', 'tx', 'xk']) {
    await query(text); assert((await symbols()).includes('HK.00700'), `find Tencent by ${text}`);
  }
  await capture('search-tencent.png');
  await query('Alibaba'); assert((await symbols()).length === 2, 'two listings share aliases but remain separate results');
  await evaluate(`(()=>{const select=document.querySelector('[aria-label="搜索市场"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'US');select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(async () => (await symbols()).length === 1, '市场筛选');
  assert((await symbols())[0] === 'US.BABA', 'market filter applies to aliases');
  await evaluate(`(()=>{const select=document.querySelector('[aria-label="搜索市场"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'all');select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await query(' aapl '); assert((await symbols())[0] === 'US.AAPL', 'case and whitespace are normalized');
  await keyboard('Enter'); await new Promise(done => setTimeout(done, 150));
  assert(service.state(false).rows.length === 0, 'Enter without explicit selection never adds a result');
  await keyboard('ArrowDown');
  await evaluate(`document.getElementById('security-query').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}))`);
  await keyboard('Enter', true); await new Promise(done => setTimeout(done, 150));
  assert(service.state(false).rows.length === 0, 'IME selection does not add securities');
  await evaluate(`document.getElementById('security-query').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))`);
  await until(async () => (await symbols()).includes('US.AAPL'), '选字结束重新搜索');
  await keyboard('ArrowDown'); await keyboard('Enter');
  await until(() => service.state(false).rows.some(item => item.symbol === 'US.AAPL' && item.permission === 'denied') && service.state(false).connection === 'connected', '无行情权限的证券仍保存');
  assert(await evaluate(`document.getElementById('security-query').value===' aapl ' && document.querySelector('.search-results button').textContent==='已添加'`), 'adding retains the query and marks the result as added');
  await query('tx');
  await evaluate(`document.querySelector('.search-results button').click()`);
  await until(() => service.state(false).rows.length === 2 && service.state(false).connection === 'connected', '直接添加腾讯');
  assert(service.state(false).rows[1].symbol === 'HK.00700', 'one click verifies and appends the selected security');
  const duplicate = await evaluate(`window.stockBar.add('HK.00700')`);
  assert(!duplicate.ok && service.state(false).rows.length === 2, 'main process rejects duplicate additions');
  await query('US.MISSING');
  await evaluate(`document.querySelector('.search-fallback button').click()`);
  await until(async () => await evaluate(`document.querySelector('.operation-message')?.textContent.includes('未找到有效证券')`), '核验失败提示');
  assert(service.state(false).rows.length === 2 && await evaluate(`document.getElementById('security-query').value==='US.MISSING'`), 'failed verification preserves the query and watchlist');
  await query('US.NEW'); await evaluate(`document.querySelector('.search-fallback button').click()`);
  await until(() => service.state(false).rows.length === 3 && service.state(false).connection === 'connected', '完整代码后备添加');
  assert(service.state(false).rows[2].symbol === 'US.NEW', 'exact-code fallback can add a security absent from the directory');
  const previous = await evaluate(`(async()=>(await window.stockBar.get()).directory.markets.find(m=>m.market==='US').updatedAt)()`);
  await command('/directory-fail');
  const refresh = await evaluate(`window.stockBar.refreshDirectory()`);
  assert(!refresh.ok && await evaluate(`(async()=>{const d=(await window.stockBar.get()).directory;return d.markets.find(m=>m.market==='HK').count>0&&d.markets.find(m=>m.market==='US').updatedAt===${previous}&&!!d.markets.find(m=>m.market==='US').error})()`), 'partial refresh retains the failed market and reports its timestamp');
  await query('aapl'); assert((await symbols()).includes('US.AAPL'), 'failed market remains searchable');
  await capture('partial-refresh.png');
  await command('/drop');
  await until(() => service.state(false).connection !== 'connected', '断线');
  await query('tx'); assert((await symbols()).includes('HK.00700'), 'offline search uses the local directory');
  await query('nvda');
  assert(await evaluate(`document.querySelector('.search-results button').disabled && document.querySelector('.search-results button').textContent==='连接后添加'`), 'offline additions are disabled in the UI');
  const offlineAdd = await evaluate(`window.stockBar.add('US.NVDA')`);
  assert(!offlineAdd.ok && service.state(false).rows.length === 3, 'main process also rejects offline additions');
  await capture('offline-search.png');
  await command('/restore'); await until(() => service.state(false).connection === 'connected', '恢复连接');
  const refreshRetry = await evaluate(`window.stockBar.refreshDirectory()`); assert(refreshRetry.ok, 'manual refresh clears recovered market errors');
  const both = [];
  for (const symbol of ['HK.09988', 'US.BABA']) {
    both.push(await evaluate(`window.stockBar.add(${JSON.stringify(symbol)})`));
    await until(() => service.state(false).connection === 'connected', '添加后恢复订阅');
  }
  assert(both.every(value => value.ok) && service.state(false).rows.length === 5, 'HK and US Alibaba listings occupy separate watchlist slots');
  const original = service.state(false).preferences.watchlist;
  const full = [...original, ...Array.from({ length: 5 }, (_, index) => ({ symbol: `US.FILL${index}`, name: 'Fixture', securityType: 3 }))];
  assert((await evaluate(`window.stockBar.setWatchlist(${JSON.stringify(full)})`)).ok, 'fixture fills watchlist to ten');
  await until(() => service.state(false).connection === 'connected', '十只证券连接');
  await query('nvda'); assert(await evaluate(`!document.querySelector('.search-results button').disabled`), 'watchlists with ten securities can still add search results');
  assert((await evaluate(`window.stockBar.add('US.NVDA')`)).ok && service.state(false).rows.length === 11, 'main process accepts more than ten securities');
  assert(service.state(false).preferences.watchlist.at(-1)?.showInBar === false, 'new additions do not appear in the bar until selected');
  await capture('full-watchlist.png');
  const forbidden = await bar.webContents.executeJavaScript(`Promise.all([window.stockBar.search('tx','all'),window.stockBar.refreshDirectory(),window.stockBar.add('US.NVDA')].map(task=>task.then(()=>false,()=>true)))`);
  assert(forbidden.every(Boolean), 'bar window cannot invoke settings-only search, refresh or add IPC');
  const report = { passed: true, version: app.getVersion(), executable: process.execPath, mode: 'protocol fixture; hidden native Electron; isolated profile', checks };
  await writeFile(resolve(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}

// Read-only real-source check. It reads the existing protected connection in the desktop bootstrap;
// never changes the user's watchlist, connection preferences or encrypted key.
export async function runSearchLiveCheck(service: QuoteService, catalog: SecurityCatalog, getSettings: () => BrowserWindow | undefined) {
  const directory = resolve('artifacts/search-live'); await mkdir(directory, { recursive: true });
  const until = async (predicate: () => boolean | Promise<boolean>, label: string) => {
    const deadline = Date.now() + 30000; let written = 0;
    while (!await predicate()) {
      if (Date.now() - written > 1000) {
        written = Date.now(); const state = service.state(false);
        await writeFile(resolve(directory, 'progress.json'), JSON.stringify({ phase: label, connection: state.connection, message: state.message, directory: catalog.state() }, null, 2));
      }
      if (Date.now() > deadline) throw Error('真实搜索验收超时：' + label + '；' + service.state(false).message);
      await new Promise(done => setTimeout(done, 100));
    }
  };
  await until(() => service.state(false).connection === 'connected', 'OpenD 连接');
  await until(() => Boolean(getSettings() && !getSettings()!.webContents.isLoading()), '设置页');
  await catalog.refresh(true);
  const states = catalog.state();
  if (states.markets.some(item => !item.count || item.error)) throw Error('真实目录未加载完整：' + states.markets.map(item => `${item.market}: ${item.error || item.count}`).join('；'));
  const samples = ['700', '腾讯', '騰訊', 'Tencent', 'tx', ' aapl '].map(query => ({ query, symbols: catalog.search(query).items.map(item => item.symbol) }));
  for (const item of samples) {
    if (!item.symbols.includes(item.query.trim().toLowerCase() === 'aapl' ? 'US.AAPL' : 'HK.00700')) throw Error('真实样例未命中：' + item.query);
  }
  const verified = [];
  for (const symbol of ['HK.00700', 'HK.02800', 'US.AAPL', 'US.SPY']) verified.push(await service.lookup(symbol));
  const settings = getSettings()!;
  await settings.webContents.executeJavaScript(`(()=>{const input=document.getElementById('security-query');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'腾讯');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await until(async () => await settings.webContents.executeJavaScript(`!!document.querySelector('.search-results [data-symbol="HK.00700"]') && !document.querySelector('.search-feedback').textContent.includes('正在')`), '真实目录经 IPC 展示');
  await settings.webContents.executeJavaScript(`document.querySelector('.security-search').scrollIntoView({block:'start'}); new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))`);
  await writeFile(resolve(directory, 'real-search.png'), (await settings.webContents.capturePage()).toPNG());
  const report = { passed: true, version: app.getVersion(), checkedAt: new Date().toISOString(), mode: 'real OpenD; read-only checks; search cache in artifacts; user settings and watchlist unchanged',
    markets: states.markets, samples, verified, aliasCoverage: '5 manually verified listings; not complete bilingual coverage' };
  await writeFile(resolve(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
}
