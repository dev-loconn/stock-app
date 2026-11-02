import { BrowserWindow, app, powerMonitor, screen } from 'electron';
import { createServer, connect, type Socket } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { QuoteProvider as QuoteService } from './market-service';
import type { Preferences, StockState } from '../shared/stock';

async function until(predicate: () => boolean | Promise<boolean>, label: string, timeout = 15000) {
  const start = Date.now();
  while (!await predicate()) {
    if (Date.now() - start > timeout) throw Error(`验收超时：${label}`);
    await new Promise(done => setTimeout(done, 20));
  }
}

/** Explicit diagnostic mode only. Proxies just this application's connection; never stops OpenD. */
export async function runRecoveryCheck(bar: BrowserWindow, service: QuoteService, preferences: Preferences, key: string,
  setVisible: (visible: boolean) => void, live: boolean) {
  const directory = resolve(process.env.STOCK_BAR_CHECK_OUTPUT || resolve(process.cwd(), live ? 'artifacts/recovery-live' : 'artifacts/recovery-fixture'));
  await mkdir(directory, { recursive: true });
  const sockets = new Set<Socket>();
  let accepting = true;
  let connections = 0;
  const proxy = createServer(downstream => {
    connections++;
    if (!accepting) { downstream.destroy(); return; }
    const upstream = connect(preferences.port, preferences.host);
    for (const socket of [downstream, upstream]) {
      sockets.add(socket); socket.on('error', () => { downstream.destroy(); upstream.destroy(); });
      socket.on('close', () => { sockets.delete(socket); downstream.destroy(); upstream.destroy(); });
    }
    downstream.pipe(upstream); upstream.pipe(downstream);
  });
  const drop = () => { for (const socket of sockets) socket.destroy(); };
  await new Promise<void>((done, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', done); });
  const address = proxy.address();
  if (!address || typeof address === 'string') throw Error('测试代理端口不可用');
  const report: Record<string, unknown> = { passed: false, mode: live ? 'real OpenD via application-only TCP fault proxy' : 'protocol fixture with real SDK and Electron renderer',
    startedAt: new Date().toISOString(), appVersion: app.getVersion(), electron: process.versions.electron, sdk: require('futu-api/package.json').version,
    platform: process.platform, display: screen.getPrimaryDisplay().scaleFactor, hardwareSleepTested: false };
  const read = () => service.state(false);
  const values = (state: StockState) => state.rows.map(row => ({ symbol: row.symbol, price: row.quote?.price, sourceEpoch: row.quote?.sourceEpoch }));
  const connected = () => read().connection === 'connected' && read().rows.every(row => Boolean(row.quote));
  const command = async (action: string, price?: number) => {
    const url = process.env.STOCK_BAR_FIXTURE_CONTROL;
    if (!url || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw Error('缺少回环夹具控制地址');
    const response = await fetch(`${url}/${action}${price === undefined ? '' : `?price=${price}`}`);
    if (!response.ok) throw Error('夹具控制失败');
    return response.json();
  };
  try {
    if (read().rows.some(row => row.quote)) throw Error('离线启动恢复了价格缓存');
    await until(async () => await bar.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.quote-line strong')).length > 0 && Array.from(document.querySelectorAll('.quote-line strong')).every(n => n.textContent === '—')`), '首次启动显示未知价格');
    report.offlineStart = { noCachedPrices: true, symbolsRestored: read().rows.length };
    service.configure({ ...preferences, host: '127.0.0.1', port: address.port }, key);
    await until(connected, '首次连接及全部自选', 45000);
    if (!preferences.watchlist.length) throw Error('真实验证需要已有自选');
    report.initial = { connection: read().connection, quotes: values(read()), diagnostics: service.diagnostics() };
    const beforeDrop = values(read());
    accepting = false; drop();
    await until(() => read().connection === 'retrying', '断线状态');
    if (JSON.stringify(values(read())) !== JSON.stringify(beforeDrop)) throw Error('断线时旧价或源时间丢失');
    await new Promise(done => setTimeout(done, 3400));
    const duringOutage = read();
    if (duringOutage.connection === 'connected') throw Error('离线时错误显示已连接');
    if (JSON.stringify(values(duringOutage)) !== JSON.stringify(beforeDrop)) throw Error('持续离线时旧价或源时间丢失');
    const restoreAt = Date.now(); accepting = true;
    await until(connected, '断线恢复', 45000);
    report.outage = { retainedQuotes: true, failedConnections: connections - 2, restoredInMs: Date.now() - restoreAt,
      fault: 'only this application socket interrupted; host network and OpenD stay running' };
    const resumes: number[] = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      const beforeSuspend = values(read());
      powerMonitor.emit('suspend');
      await until(() => sockets.size === 0, '休眠事件释放连接');
      const count = connections;
      await new Promise(done => setTimeout(done, 1200));
      if (connections !== count || read().connection !== 'disconnected') throw Error('休眠期间仍在连接');
      if (JSON.stringify(values(read())) !== JSON.stringify(beforeSuspend)) throw Error('休眠事件丢失旧行情');
      const start = Date.now(); powerMonitor.emit('resume');
      await until(connected, '唤醒事件恢复', 45000);
      resumes.push(Date.now() - start);
      if (sockets.size !== 2) throw Error('恢复后连接数量异常');
    }
    report.powerEvents = { cycles: 3, restoredInMs: resumes, injection: 'Electron powerMonitor suspend/resume events; no physical sleep' };
    if (!live) {
      await bar.webContents.executeJavaScript(`(() => {
        window.__quoteFrames = [];
        const record = () => requestAnimationFrame(() => requestAnimationFrame(() => {
          window.__quoteFrames.push({ at: Date.now(), prices: Array.from(document.querySelectorAll('.quote-line strong')).map(n => n.textContent) });
        }));
        new MutationObserver(record).observe(document.querySelector('.bar-quotes'), { subtree: true, childList: true, characterData: true });
        record();
      })()`);
      const samples: { scenario: string; page: number; receivedToFrameMs: number }[] = [];
      const capacity = await bar.webContents.executeJavaScript(`document.querySelectorAll('.quote-tile').length`) as number;
      const pages = Math.ceil(read().rows.length / capacity);
      let price = 110;
      async function sample(scenario: string, page: number) {
        const expectedRows = Math.min(capacity, read().rows.length - (page - 1) * capacity);
        price++;
        await bar.webContents.executeJavaScript('window.__quoteFrames = []');
        await command('push', price);
        await until(() => read().rows.every(row => row.quote?.price === price), '10 只推送全部接收');
        const receivedAt = Math.min(...read().rows.map(row => row.quote!.receivedAt));
        let frame: { at: number; prices: string[] } | undefined;
        await until(async () => {
          frame = await bar.webContents.executeJavaScript(`window.__quoteFrames.find(f => f.prices.length === ${expectedRows} && f.prices.every(p => p === '${price.toFixed(2)}'))`);
          return Boolean(frame);
        }, 'React 界面绘制行情', 4000);
        const delay = frame!.at - receivedAt;
        samples.push({ scenario, page, receivedToFrameMs: delay });
        if (delay < 0 || delay > 1000) throw Error(`收到至绘制超过 1 秒：${delay}ms`);
      }
      for (let page = 1; page <= pages; page++) {
        if (page > 1) {
          await new Promise(done => setTimeout(done, 180));
          await bar.webContents.executeJavaScript(`document.querySelector('.stock-bar').dispatchEvent(new WheelEvent('wheel', {deltaY:100, bubbles:true}))`);
          await until(async () => (await bar.webContents.executeJavaScript(`document.querySelector('.page-number').textContent`)) === `${page}/${pages}`, `第 ${page} 页`);
        }
        const pageSamples = Math.floor(20 / pages) + (page <= 20 % pages ? 1 : 0);
        for (let i = 0; i < pageSamples; i++) await sample('visible', page);
      }
      setVisible(false);
      await command('push', ++price);
      await until(() => read().rows.every(row => row.quote?.price === price), '隐藏期间更新');
      if (bar.isVisible()) throw Error('隐藏场景未真正隐藏窗口');
      const showAt = Date.now(); setVisible(true);
      await until(async () => (await bar.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.quote-line strong')).every(n=>n.textContent==='${price.toFixed(2)}')`)), '恢复后显示最新行情');
      const showToLatestMs = Date.now() - showAt;
      if (showToLatestMs > 1000) throw Error('恢复窗口后显示更新超过 1 秒');
      for (let i = 0; i < 5; i++) await sample('after-hidden', pages);
      service.reconnect(); await until(connected, '延迟测量前重连');
      for (let i = 0; i < 5; i++) await sample('after-reconnect', pages);
      await writeFile(join(directory, 'quotes.png'), (await bar.webContents.capturePage()).toPNG());
      const sorted = samples.map(item => item.receivedToFrameMs).sort((a, b) => a - b);
      report.latency = { boundary: 'SDK receipt -> React DOM commit -> two requestAnimationFrame callbacks (paint opportunity), not physical display latency',
        symbols: 10, pages, capacity, samples, maxMs: sorted.at(-1), p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], showToLatestMs };
      report.fixture = await command('stats');
    } else {
      report.final = { connection: read().connection, quotes: values(read()), diagnostics: service.diagnostics() };
    }
    const metrics = () => app.getAppMetrics().map(metric => ({ type: metric.type, cpu: metric.cpu.percentCPUUsage, memory: metric.memory }));
    report.memory = metrics();
    const soakMs = Math.min(600000, Math.max(0, Number(process.env.STOCK_BAR_SOAK_MS) || 0));
    if (soakMs) {
      const start = Date.now(); const samples = [];
      const initialConnections = connections;
      while (Date.now() - start < soakMs) {
        await new Promise(done => setTimeout(done, 5000));
        if (!live) await command('push', 200 + samples.length);
        if (!connected() || sockets.size !== 2 || connections !== initialConnections) throw Error('持续运行期间连接状态异常');
        samples.push({ elapsedMs: Date.now() - start, metrics: metrics() });
      }
      report.soak = { durationMs: Date.now() - start, samples, finalConnections: connections,
        description: 'short bounded observation, not a long-duration resource stability guarantee' };
    }
    report.connections = connections; report.passed = true;
  } catch (error) { report.error = error instanceof Error ? error.message : '验收失败'; }
  finally {
    service.stop(); drop(); await new Promise<void>(done => proxy.close(() => done()));
    report.finishedAt = new Date().toISOString();
    await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify({ passed: report.passed, mode: report.mode, error: report.error, evidence: directory }));
  if (!report.passed) throw Error(String(report.error));
}
