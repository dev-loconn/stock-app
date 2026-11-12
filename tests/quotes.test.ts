import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QuoteService } from '../src/main/quotes';
import { DEFAULT_PREFERENCES } from '../src/shared/stock';
import { createGateway, type GatewayOptions } from './gateway';

beforeEach(() => { vi.spyOn(console, 'debug').mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); });
async function until(predicate: () => boolean, timeout = 3000) {
  const started = Date.now();
  while (!predicate()) { if (Date.now() - started > timeout) throw new Error('condition timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
}
it('loads both supported directory types and rejects delisted or unknown securities during exact verification', async () => {
  const gateway = await createGateway({ directoryItems: [
    { symbol: 'HK.00700', name: '腾讯控股', securityType: 3 }, { symbol: 'HK.02800', name: '盈富基金', securityType: 4 },
    { symbol: 'HK.00001', name: '退市样本', securityType: 3, delisting: true }, { symbol: 'HK.00002', name: '未知股票', securityType: 3 },
  ] });
  const preferences = { ...DEFAULT_PREFERENCES, port: gateway.port };
  const service = new QuoteService(preferences, () => undefined, { pollMs: 200, retryMs: [50] });
  try {
    service.configure(preferences, ''); await until(() => service.state(false).connection === 'connected');
    const items = await service.directory('HK');
    expect(items.map(item => item.symbol)).toEqual(['HK.00700', 'HK.02800']);
    const calls = gateway.calls.filter(call => call.cmd === 3202 && call.c2s.market === 1);
    expect(calls.map(call => call.c2s.secType)).toEqual([3, 4]);
    await expect(service.lookup('HK.00001')).rejects.toThrow('未找到有效证券');
    await expect(service.lookup('HK.00002')).rejects.toThrow('未找到有效证券');
  } finally { service.stop(); await gateway.close(); }
});
it('keeps a real SDK subscription open, independently of the visible page, until stopped', async () => {
  const gateway = await createGateway();
  const preferences = { ...DEFAULT_PREFERENCES, port: gateway.port, watchlist: [
    { symbol: 'US.AAPL', name: 'Apple', securityType: 3 }, { symbol: 'HK.00700', name: 'Tencent', securityType: 3 },
  ] };
  const service = new QuoteService(preferences, () => undefined, { pollMs: 200, retryMs: [50] });
  try {
    service.configure(preferences, '');
    await until(() => service.state(false).rows.every(row => row.quote?.price === 101));
    await new Promise(resolve => setTimeout(resolve, 1150));
    const state = service.state(false);
    expect(state.connection).toBe('connected'); expect(state.rows.every(row => row.pushCount === 1)).toBe(true);
    expect(state.rows.every(row => row.timeliness === 'unknown')).toBe(true);
    expect(gateway.openConnections()).toBe(1);
    expect(await service.lookup('US.AAPL')).toMatchObject({ symbol: 'US.AAPL', name: 'FIXTURE ONLY' });
    service.stop(); await until(() => gateway.openConnections() === 0);
    expect(gateway.calls.filter(call => call.cmd === 3001)).toHaveLength(2);
  } finally { service.stop(); await gateway.close(); }
});
it('automatically reconnects and restores subscriptions after a dropped connection', async () => {
  const gateway = await createGateway({ disconnect: true });
  const preferences = { ...DEFAULT_PREFERENCES, port: gateway.port, watchlist: [{ symbol: 'US.AAPL', name: 'Apple', securityType: 3 }] };
  const service = new QuoteService(preferences, () => undefined, { pollMs: 200, retryMs: [50] });
  try {
    service.configure(preferences, '');
    await until(() => gateway.calls.filter(call => call.cmd === 3001).length >= 2);
    expect(gateway.connections()).toBeGreaterThanOrEqual(2);
    expect(service.state(false).rows[0].quote?.price).toBe(101);
    service.stop(); const connections = gateway.connections();
    await new Promise(resolve => setTimeout(resolve, 200)); expect(gateway.connections()).toBe(connections);
  } finally { service.stop(); await gateway.close(); }
});
it('falls back to BMP snapshots without falsely claiming realtime data', async () => {
  const gateway = await createGateway({ bmp: true });
  const preferences = { ...DEFAULT_PREFERENCES, port: gateway.port, watchlist: [{ symbol: 'HK.00700', name: 'Tencent', securityType: 3 }] };
  const service = new QuoteService(preferences, () => undefined, { pollMs: 200, retryMs: [50] });
  try {
    service.configure(preferences, ''); await until(() => service.state(false).rows[0].quote?.price === 101);
    const row = service.state(false).rows[0];
    expect(row.permission).toBe('available'); expect(row.timeliness).toBe('unknown'); expect(row.status).toContain('快照');
    expect(gateway.calls.some(call => call.cmd === 3203)).toBe(true);
  } finally { service.stop(); await gateway.close(); }
});
it('requests extended-hours tickers and calculates against same-day close through the real SDK', async () => {
  const gateway = await createGateway({ usState: 10 });
  const preferences = { ...DEFAULT_PREFERENCES, port: gateway.port, watchlist: [{ symbol: 'US.AAPL', name: 'Apple', securityType: 3 }] };
  const service = new QuoteService(preferences, () => undefined, { pollMs: 1000, retryMs: [50] });
  try {
    service.configure(preferences, ''); await until(() => service.state(false).rows[0].quote?.session === 'after');
    expect(service.state(false).rows[0].quote?.changePercent).toBeCloseTo(3);
    expect(gateway.calls.some(call => call.cmd === 3001 && call.c2s.session === 2 && call.c2s.extendedTime === true)).toBe(true);
    expect(gateway.calls.some(call => call.cmd === 3010)).toBe(true);
  } finally { service.stop(); await gateway.close(); }
});

it('switches OpenD from extended-hours to overnight subscriptions and preserves the close across midnight', async () => {
  const options: GatewayOptions = { usState: 10 };
  const gateway = await createGateway(options);
  const preferences = { ...DEFAULT_PREFERENCES, port: gateway.port, watchlist: [{ symbol: 'US.SOXL', name: 'SOXL', securityType: 4 }] };
  const service = new QuoteService(preferences, () => undefined, { pollMs: 50, retryMs: [50] });
  try {
    service.configure(preferences, ''); await until(() => service.state(false).rows[0].quote?.session === 'after');
    options.usState = 37; options.serverNow = Date.parse('2026-10-24T04:01:00Z');
    options.basicTime = '2026-10-23 15:59:59'; options.tickerTime = '2026-10-23 23:59:59';
    await until(() => {
      const row = service.state(false).rows[0];
      return row.status === '数据异常' || row.quote?.session === 'overnight';
    });
    const row = service.state(false).rows[0];
    expect(row.status, row.error).toBe('夜盘');
    expect(row.quote).toMatchObject({ price: 103, baseline: 100 });
    expect(service.state(false).rows[0].quote?.changePercent).toBeCloseTo(3);
    expect(gateway.calls.some(call => call.cmd === 3001 && call.c2s.isSubOrUnSub === false && call.c2s.session === 2)).toBe(true);
    expect(gateway.calls.some(call => call.cmd === 3001 && call.c2s.isSubOrUnSub === true && call.c2s.session === 3)).toBe(true);
  } finally { service.stop(); await gateway.close(); }
});

it('keeps the pre-market quote while OpenD reports a stale global overnight state', async () => {
  const options: GatewayOptions = {
    usState: 37, serverNow: Date.parse('2026-11-12T08:59:59Z'),
    basicTime: '2026-11-11 16:00:00', tickerTime: '2026-11-12 03:59:58',
  };
  const gateway = await createGateway(options);
  const preferences = { ...DEFAULT_PREFERENCES, port: gateway.port, watchlist: [{ symbol: 'US.SOXL', name: 'SOXL', securityType: 4 }] };
  const publishedPrices: Array<number | undefined> = [];
  const service = new QuoteService(preferences, () => { publishedPrices.push(row().quote?.price); }, { pollMs: 50, retryMs: [50] });
  const row = () => service.state(false).rows[0];
  const marketStateRequests = () => gateway.calls.filter(call => call.cmd === 3223).length;
  let releaseMarketState: (() => void) | undefined;
  try {
    service.configure(preferences, '');
    await until(() => row().quote?.session === 'overnight');
    const overnight = row().quote?.price;

    options.usState = 8;
    options.serverNow = Date.parse('2026-11-12T09:00:01Z');
    options.tickerTime = '2026-11-12 04:00:00';
    options.tickerPrice = 105;
    await until(() => row().quote?.session === 'pre');
    const pre = row().quote?.price;

    const before = marketStateRequests();
    options.marketStateGate = new Promise(resolve => { releaseMarketState = resolve; });
    options.globalUsState = 37;
    await until(() => marketStateRequests() > before);
    const published = publishedPrices.length;
    gateway.pushQuotes([{ market: 11, code: 'SOXL' }], 100);
    await until(() => publishedPrices.length > published);
    const pending = publishedPrices.at(-1);
    releaseMarketState?.();
    await until(() => row().marketState === 8);
    expect([overnight, pre, pending, row().quote?.price]).toEqual([103, 105, 105, 105]);
  } finally { releaseMarketState?.(); service.stop(); await gateway.close(); }
});

it('recovers a transient subscription failure without reconnecting healthy securities', async () => {
  const gateway = await createGateway({ failSubscriptions: 1 });
  const preferences = { ...DEFAULT_PREFERENCES, port: gateway.port, watchlist: [
    { symbol: 'US.AAPL', name: 'Apple', securityType: 3 }, { symbol: 'HK.00700', name: 'Tencent', securityType: 3 },
  ] };
  const service = new QuoteService(preferences, () => undefined, { pollMs: 50, retryMs: [50] });
  try {
    service.configure(preferences, '');
    await until(() => service.state(false).rows.every(row => row.quote?.price === 101 && !row.error), 1500);
    expect(gateway.connections()).toBe(1);
    expect(gateway.calls.filter(call => call.cmd === 3001 && (call.c2s.securityList as {code: string}[])[0].code === '00700')).toHaveLength(1);
  } finally { service.stop(); await gateway.close(); }
});

it('escalates retries when sessions repeatedly drop immediately after subscribing', async () => {
  const gateway = await createGateway({ disconnect: true });
  const preferences = { ...DEFAULT_PREFERENCES, port: gateway.port, watchlist: [{ symbol: 'US.AAPL', name: 'Apple', securityType: 3 }] };
  const delays: number[] = [];
  const service = new QuoteService(preferences, () => {
    const state = service.state(false);
    if (state.connection === 'retrying') delays.push((state.retryAt || 0) - Date.now());
  }, { pollMs: 1000, retryMs: [150, 300, 600] });
  try {
    service.configure(preferences, '');
    await until(() => delays.length >= 3);
    expect(delays[1]).toBeGreaterThan(180);
    expect(delays[2]).toBeGreaterThan(450);
  } finally { service.stop(); await gateway.close(); }
});

it('preserves all ten quotes across outages and repeated suspend/resume without accumulating subscriptions', async () => {
  const gateway = await createGateway();
  const watchlist = Array.from({ length: 10 }, (_, index) => ({ symbol: `HK.${String(index + 1).padStart(5, '0')}`, name: `FIXTURE ${index}`, securityType: 3 }));
  const preferences = { ...DEFAULT_PREFERENCES, port: gateway.port, watchlist };
  const service = new QuoteService(preferences, () => undefined, { pollMs: 50, retryMs: [50, 100, 200] });
  try {
    service.configure(preferences, '');
    await until(() => service.state(false).connection === 'connected');
    const quotes = service.state(false).rows.map(row => row.quote);
    gateway.setAccepting(false); gateway.dropConnections();
    await until(() => service.state(false).connection === 'retrying');
    expect(service.state(false).rows.map(row => row.quote)).toEqual(quotes);
    gateway.setAccepting(true);
    await until(() => service.state(false).connection === 'connected');
    for (let cycle = 0; cycle < 3; cycle++) {
      const beforeSuspend = service.state(false).rows.map(row => row.quote);
      service.suspend();
      await until(() => gateway.openConnections() === 0);
      const connections = gateway.connections();
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(gateway.connections()).toBe(connections);
      expect(service.state(false).connection).toBe('disconnected');
      expect(service.state(false).rows.map(row => row.quote)).toEqual(beforeSuspend);
      service.reconnect();
      await until(() => service.state(false).connection === 'connected');
      expect(gateway.openConnections()).toBe(1);
      const subscriptions = gateway.calls.filter(call => call.connection === gateway.connections() && call.cmd === 3001);
      expect(subscriptions).toHaveLength(10);
      expect(new Set(subscriptions.map(call => (call.c2s.securityList as { code: string }[])[0].code)).size).toBe(10);
    }
    gateway.pushQuotes(watchlist.map(item => ({ market: 1, code: item.symbol.slice(3) })), 102);
    await until(() => service.state(false).rows.every(row => row.quote?.price === 102));
    service.stop(); await until(() => gateway.openConnections() === 0);
  } finally { service.stop(); await gateway.close(); }
});

it('detects an open but unresponsive transport and restores its subscriptions', async () => {
  const gateway = await createGateway();
  const preferences = { ...DEFAULT_PREFERENCES, port: gateway.port, watchlist: [{ symbol: 'US.AAPL', name: 'Apple', securityType: 3 }] };
  const service = new QuoteService(preferences, () => undefined, { pollMs: 50, retryMs: [200] });
  try {
    service.configure(preferences, '');
    await until(() => service.state(false).connection === 'connected');
    const quote = service.state(false).rows[0].quote;
    gateway.setResponsive(false);
    await until(() => service.state(false).connection === 'retrying', 7500);
    expect(service.state(false).message).toMatch(/超时|timeout/i);
    expect(service.state(false).rows[0].quote).toEqual(quote);
    gateway.setResponsive(true);
    await until(() => service.state(false).connection === 'connected');
    expect(gateway.openConnections()).toBe(1);
    expect(gateway.calls.filter(call => call.cmd === 3001)).toHaveLength(2);
  } finally { service.stop(); await gateway.close(); }
}, 12000);

it('rechecks previously denied securities on a new connection without repeatedly subscribing them while denied', async () => {
  const options = { deniedCode: 'AAPL' as string | undefined };
  const gateway = await createGateway(options);
  const preferences = { ...DEFAULT_PREFERENCES, port: gateway.port, watchlist: [{ symbol: 'US.AAPL', name: 'Apple', securityType: 3 }] };
  const service = new QuoteService(preferences, () => undefined, { pollMs: 50, retryMs: [100] });
  try {
    service.configure(preferences, '');
    await until(() => service.state(false).rows[0].permission === 'denied');
    await new Promise(done => setTimeout(done, 200));
    expect(gateway.calls.filter(call => call.cmd === 3001)).toHaveLength(1);
    options.deniedCode = undefined;
    service.reconnect();
    await until(() => service.state(false).rows[0].permission === 'available');
    await until(() => service.state(false).rows[0].quote?.price === 101);
    expect(service.state(false).rows[0].error).toBeUndefined();
  } finally { service.stop(); await gateway.close(); }
});

it('runs the heartbeat while initial extended-hours requests are stalled', async () => {
  const gateway = await createGateway({ usState: 10, silentCommands: [3010] });
  const watchlist = Array.from({ length: 10 }, (_, index) => ({ symbol: `US.TEST${index}`, name: `FIXTURE ${index}`, securityType: 3 }));
  const preferences = { ...DEFAULT_PREFERENCES, port: gateway.port, watchlist };
  const service = new QuoteService(preferences, () => undefined, { pollMs: 50, retryMs: [500] });
  try {
    service.configure(preferences, '');
    await until(() => gateway.calls.some(call => call.cmd === 3010));
    gateway.setResponsive(false);
    await until(() => service.state(false).connection === 'retrying', 7000);
    expect(service.state(false).rows.every(row => row.quote?.price === 100)).toBe(true);
    expect(gateway.calls.filter(call => call.cmd === 3010).length).toBeLessThan(10);
    await until(() => gateway.openConnections() === 0);
  } finally { service.stop(); await gateway.close(); }
}, 12000);
