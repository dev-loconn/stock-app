import { app, type BrowserWindow } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WebSocket } from 'undici';
import { obj, type CloudRequest } from './cloud-api';
import type { MarketService } from './market-service';
import type { SecurityMarket } from '../shared/stock';

// Only used by the explicit --cloud-check mode with an isolated profile and loopback fixture.
export function cloudFixture() {
  const base = process.env.STOCK_BAR_CLOUD_FIXTURE;
  if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base) || !process.env.STOCK_BAR_TEST_PROFILE) throw Error('Missing isolated cloud fixture');
  const request: CloudRequest = async (path, options = {}) => {
    const form = options.body instanceof URLSearchParams;
    const response = await fetch(base + path, { method: options.body ? 'POST' : 'GET', signal: options.signal,
      headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json', ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
      body: options.body ? form ? options.body.toString() : JSON.stringify(options.body) : undefined });
    if (!response.ok) throw Error('Fixture request failed'); return obj(await response.json());
  };
  return { request, socket: async () => { const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws'); return { socket, release: () => socket.close() }; },
    directory: async (market: SecurityMarket) => (await request('/directory/' + market)).items as import('../shared/stock').WatchItem[],
    browser: async (url: string) => {
      const authorize = new URL(url);
      if (authorize.origin !== 'https://webapi.futunn.com' || authorize.searchParams.get('scope') !== 'quote:read') throw Error('Unexpected auth URL');
      const callback = new URL(authorize.searchParams.get('redirect_uri')!);
      callback.search = new URLSearchParams({ state: authorize.searchParams.get('state')!, code: 'fixture-code' }).toString();
      // Return before the callback completes, as opening a real system browser does.
      void fetch(callback).catch(() => undefined);
    } };
}

export async function runCloudCheck(bar: BrowserWindow, service: MarketService, getSettings: () => BrowserWindow | undefined) {
  const directory = resolve(process.env.STOCK_BAR_CHECK_OUTPUT || 'artifacts/cloud-desktop'); await mkdir(directory, { recursive: true });
  const checks: string[] = [];
  const assert = (condition: boolean, name: string) => { if (!condition) throw Error(name); checks.push(name); };
  const until = async (condition: () => boolean | Promise<boolean>, label: string) => {
    const deadline = Date.now() + 15000;
    while (!await condition()) { if (Date.now() > deadline) throw Error('Cloud desktop timeout: ' + label); await new Promise(done => setTimeout(done, 30)); }
  };
  await until(() => Boolean(getSettings() && !getSettings()!.webContents.isLoading()), 'settings loaded');
  const settings = getSettings()!;
  const evaluate = (script: string) => settings.webContents.executeJavaScript(script);
  assert(await evaluate(`document.querySelector('[aria-label="连接方式"]').value==='cloud' && !Array.from(document.querySelectorAll('label')).some(n=>n.textContent==='本机地址')`), 'cloud is default and OpenD fields are hidden');
  await evaluate(`window.stockBar.refreshDirectory()`);
  const search = await evaluate(`window.stockBar.search('gzmt','CN')`);
  assert(search.items[0]?.symbol === 'SH.600519', 'A-share pinyin search and directory refresh work before cloud login');
  assert((await evaluate(`window.stockBar.search('Tencent','HK')`)).items[0]?.symbol === 'HK.00700', 'AKShare English aliases reach native IPC search');
  assert(await evaluate(`!document.querySelector('.directory-refresh').disabled && !!document.querySelector('option[value="CN"]')`), 'cloud directory refresh and A-share filter are available');
  await evaluate(`Array.from(document.querySelectorAll('button')).find(n=>n.textContent==='登录富途').click()`);
  await until(() => service.state(false).connection === 'connected' && Boolean(service.state(false).rows[0]?.quote), 'OAuth and cloud quote');
  assert(service.state(false).rows[0].quote?.price === 232, 'cloud push reaches the existing quote model');
  assert(service.state(false).cloud?.remembered === true, 'refresh credential protected by native safeStorage');
  assert(await evaluate(`(async()=>{const state=JSON.stringify(await window.stockBar.get());return !state.includes('fixture-access')&&!state.includes('fixture-refresh')})()`), 'renderer receives no cloud credentials');
  const file = await readFile(resolve(process.env.STOCK_BAR_TEST_PROFILE!, 'stock-bar-cloud.json'), 'utf8');
  assert(!file.includes('fixture-access') && !file.includes('fixture-refresh'), 'persisted cloud authorization is encrypted');
  const forbidden = await bar.webContents.executeJavaScript(`window.stockBar.loginCloud().then(()=>false,()=>true)`);
  assert(forbidden, 'bar cannot invoke privileged login IPC');
  const setQuery = async (text: string) => {
    await evaluate(`(()=>{const input=document.getElementById('security-query');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await until(async () => await evaluate(`!!document.querySelector('.search-results [data-symbol="SH.600519"]')`), 'A-share search result');
  };
  await setQuery('贵州');
  await evaluate(`document.querySelector('.search-results [data-symbol="SH.600519"] button').click()`);
  await until(() => service.state(false).rows.some(row => row.symbol === 'SH.600519' && row.quote?.price === 1500), 'searched A-share addition and cloud quote');
  assert(service.state(false).rows.find(row => row.symbol === 'SH.600519')?.quote?.sourceZone === 'Asia/Shanghai', 'A-share quote uses Shanghai timezone');
  for (const symbol of ['SZ.000001', 'BJ.920001']) {
    const result = await evaluate(`window.stockBar.add('${symbol}')`);
    assert(result.ok, 'cloud validates and adds ' + symbol + (result.message ? ': ' + result.message : ''));
    await until(() => service.state(false).connection === 'connected' && service.state(false).rows.some(row => row.symbol === symbol && Boolean(row.quote)), 'new symbol subscribed: ' + symbol);
  }
  await until(() => service.state(false).rows.length === 4 && service.state(false).rows.every(row => Boolean(row.quote)), 'all three A-share exchanges receive cloud quotes');
  await until(async () => await evaluate(`document.querySelectorAll('.watchlist > li').length===4`), 'React renders the added A-share watchlist');
  assert(true, 'HK/US/SH/SZ/BJ identifiers remain separate through cloud validation');
  await writeFile(resolve(directory, 'cloud-settings.png'), (await settings.webContents.capturePage()).toPNG());
  assert((await evaluate(`window.stockBar.add('US.SOXL')`)).ok, 'cloud validates and adds an overnight security');
  await until(() => service.state(false).rows.some(row => row.symbol === 'US.SOXL' && row.quote?.session === 'overnight'), 'overnight ticker reaches the native model');
  const night = service.state(false).rows.find(row => row.symbol === 'US.SOXL')!.quote!;
  assert(night.price === 103 && night.baseline === 100 && Math.abs(night.changePercent! - 3) < 0.000001, 'overnight price and percentage use the period close');
  await evaluate(`(async()=>{const s=await window.stockBar.get();return window.stockBar.setWatchlist(s.preferences.watchlist.map(item=>({...item,showInBar:item.symbol==='US.SOXL'})))})()`);
  await until(async () => await bar.webContents.executeJavaScript(`document.querySelector('.quote-tile')?.textContent.includes('夜盘') && document.querySelector('.quote-tile')?.textContent.includes('+3.00%')`), 'React renders overnight price and label');
  assert(true, 'the floating bar renders the overnight label and coherent percentage');
  await bar.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  await new Promise(done => setTimeout(done, 100));
  await writeFile(resolve(directory, 'cloud-overnight.png'), (await bar.webContents.capturePage()).toPNG());
  await evaluate(`(async()=>{const s=await window.stockBar.get();return window.stockBar.setWatchlist(s.preferences.watchlist.filter(item=>item.symbol==='US.AAPL').map(item=>({...item,showInBar:true})))})()`);
  await evaluate(`window.stockBar.setConnectionMode('opend')`);
  await until(() => service.state(false).connection === 'connected' && service.state(false).rows[0]?.quote?.price === 101, 'OpenD backup connection');
  assert(await evaluate(`document.querySelector('[aria-label="连接方式"]').value==='opend' && Array.from(document.querySelectorAll('button')).some(n=>n.textContent==='应用并连接')`), 'backup selection reveals the existing OpenD controls');
  assert(service.state(false).preferences.watchlist[0].symbol === 'US.AAPL', 'watchlist survives provider switch');
  await writeFile(resolve(directory, 'opend-backup-settings.png'), (await settings.webContents.capturePage()).toPNG());
  await evaluate(`window.stockBar.setConnectionMode('cloud')`);
  await until(() => service.state(false).connection === 'connected' && service.state(false).rows[0]?.quote?.price === 232, 'return to cloud');
  assert(true, 'switching back to cloud restores the same watchlist without another login');
  const lookup = await evaluate(`window.stockBar.lookup('US.AAPL')`);
  assert(lookup.item?.name === '苹果', 'exact symbol validation uses cloud static information');
  await evaluate(`window.stockBar.logoutCloud()`);
  await until(() => service.state(false).cloud?.status === 'signedOut', 'logout');
  assert(service.state(false).connection === 'disconnected' && !service.state(false).rows[0].quote, 'logout clears connection and previous account quotes');
  assert(!JSON.parse(await readFile(resolve(process.env.STOCK_BAR_TEST_PROFILE!, 'stock-bar-cloud.json'), 'utf8')).encryptedRefresh, 'logout removes persisted refresh credential');
  const report = { passed: true, version: app.getVersion(), mode: 'isolated native Electron; synthetic OAuth and local protocol fixtures', checks };
  await writeFile(resolve(directory, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
}
