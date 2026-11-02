import { expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { WebSocket } from 'undici';
import { CloudQuoteService } from '../src/main/cloud-quotes';
import { type CloudRequest } from '../src/main/cloud-api';
import { DEFAULT_PREFERENCES } from '../src/shared/stock';

async function until(predicate: () => boolean) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 3000) throw Error('condition timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

it.each([
  { session: 'pre', state: 'PRE_MARKET_BEGIN', period: 'BEFORE', now: '2026-10-30T12:30:00Z', regular: '2026-10-29T20:00:00Z', price: 98, baseline: 100, change: -2 },
  { session: 'after', state: 'AFTER_HOURS_BEGIN', period: 'AFTER', now: '2026-10-30T21:00:00Z', regular: '2026-10-30T20:00:00Z', price: 103, baseline: 100, change: 3 },
  { session: 'overnight', state: 'OVERNIGHT', period: 'OVERNIGHT', now: '2026-10-30T05:00:00Z', regular: '2026-10-29T20:00:00Z', price: 103, baseline: 100, change: 3 },
])('uses timestamped cloud tickers for SOXL $session quotes with the correct regular close', async sample => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(done => server.once('listening', done));
  const address = server.address(); if (typeof address === 'string') throw Error('Expected address');
  const tickerFrames: string[][] = [];
  server.on('connection', socket => socket.on('message', raw => {
    const frame = JSON.parse(String(raw));
    if (frame.action === 'auth') socket.send(JSON.stringify({ session_id: 'fixture-session' }));
    if (frame.action === 'subscribe' && frame.ticker) tickerFrames.push(frame.ticker);
  }));
  const now = Date.parse(sample.now); const requests: string[] = [];
  const request: CloudRequest = async path => {
    requests.push(path);
    if (path.endsWith('server-time')) return { server_time_ms: String(now) };
    if (path.endsWith('market-state')) return { data: { market_state_list: [{ code: 'US.SOXL', market_state: sample.state }] } };
    if (path.includes('/rt-ticker?')) return { data: { code: 'US.SOXL', last_close: sample.baseline,
      ticker_list: [{ price: sample.price, time: now - 1000, period_type: sample.period }] } };
    return { data: { quote_list: [{ code: 'US.SOXL', last_price: 100, prev_close_price: 90,
      data_time: Date.parse(sample.regular), [sample.session === 'pre' ? 'pre_market' : 'after_market']: { price: sample.price, change_rate: 999 } }] } };
  };
  const preferences = { ...DEFAULT_PREFERENCES, watchlist: [{ symbol: 'US.SOXL', name: 'SOXL', securityType: 4 }] };
  const service = new CloudQuoteService(preferences, () => undefined,
    { state: () => ({ status: 'authorized', remembered: false, message: '' }), token: async () => 'fixture-token' }, request,
    async () => { const socket = new WebSocket(`ws://127.0.0.1:${address.port}`); return { socket, release: () => socket.close() }; });
  try {
    service.configure(preferences, ''); await until(() => ['connected', 'retrying'].includes(service.state(false).connection));
    expect(service.state(false).message).toBe('已连接富途云端');
    const row = service.state(false).rows[0];
    expect(row.quote).toMatchObject({ session: sample.session, price: sample.price, baseline: sample.baseline, sourceEpoch: now - 1000 });
    expect(row.quote?.changePercent).toBeCloseTo(sample.change);
    expect(requests.some(path => path.includes('/US.SOXL/rt-ticker?') && path.includes(`period=${sample.period}`))).toBe(true);
    await until(() => tickerFrames.length === 1);
    expect(tickerFrames[0]).toEqual(['US.SOXL']); expect(service.diagnostics().extendedSubscriptions).toBe(1);
    for (const socket of server.clients) socket.send(JSON.stringify({ type: 'TICKER', symbol: 'US.SOXL', data: { ticker_list: [
      { price: sample.price + 1, time_ms: now }, { price: 1, time_ms: now - 86400000 },
    ] } }));
    await until(() => service.state(false).rows[0].quote?.price === sample.price + 1);
    expect(service.state(false).rows[0].quote).toMatchObject({ price: sample.price + 1, baseline: sample.baseline, sourceEpoch: now });
    service.reconnect(); await until(() => service.state(false).connection === 'connected');
    expect(service.state(false).rows[0].quote).toMatchObject({ price: sample.price + 1, baseline: sample.baseline, sourceEpoch: now });
  } finally {
    service.stop(); for (const socket of server.clients) socket.terminate();
    await new Promise<void>(done => server.close(() => done()));
  }
});

it('isolates a failed extended subscription and REST permission from healthy basic quotes, then retries', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(done => server.once('listening', done));
  const address = server.address(); if (typeof address === 'string') throw Error('Expected address');
  let deny = true; let connections = 0; let tickerCalls = 0;
  server.on('connection', socket => { connections++; socket.on('message', raw => {
    const frame = JSON.parse(String(raw));
    if (frame.action === 'auth') socket.send(JSON.stringify({ session_id: 'fixture-session' }));
    if (frame.ticker && deny) socket.send(JSON.stringify({ id: frame.id, code: -9 }));
  }); });
  const now = Date.parse('2026-10-30T21:00:00Z');
  const { CloudError } = await import('../src/main/cloud-api');
  const request: CloudRequest = async path => {
    if (path.endsWith('server-time')) return { server_time_ms: String(now) };
    if (path.endsWith('market-state')) return { data: { market_state_list: [{ code: 'US.SOXL', market_state: 'AFTER_HOURS_BEGIN' }] } };
    if (path.includes('/rt-ticker?')) {
      tickerCalls++; if (deny) throw new CloudError('逐笔权限不足', -9);
      return { data: { code: 'US.SOXL', last_close: 100, ticker_list: [{ price: 103, time: now, period_type: 'AFTER' }] } };
    }
    return { data: { quote_list: [
      { code: 'US.SOXL', last_price: 100, prev_close_price: 90, data_time: now - 3600000 },
      { code: 'HK.00700', last_price: 400, prev_close_price: 390, data_time: now },
    ] } };
  };
  const preferences = { ...DEFAULT_PREFERENCES, watchlist: [
    { symbol: 'US.SOXL', name: 'SOXL', securityType: 4 }, { symbol: 'HK.00700', name: '腾讯', securityType: 3 },
  ] };
  const service = new CloudQuoteService(preferences, () => undefined,
    { state: () => ({ status: 'authorized', remembered: false, message: '' }), token: async () => 'fixture-token' }, request,
    async () => { const socket = new WebSocket(`ws://127.0.0.1:${address.port}`); return { socket, release: () => socket.close() }; },
    { pollMs: 50, retryMs: [1000], refreshMs: 240000 });
  try {
    service.configure(preferences, ''); await until(() => service.state(false).connection === 'connected' && tickerCalls >= 1);
    let rows = service.state(false).rows;
    expect(rows[0].quote?.price).toBe(100); expect(rows[0].error).toContain('扩展时段');
    expect(rows[1].quote?.price).toBe(400); expect(rows[1].error).toBeUndefined();
    deny = false; await until(() => service.state(false).rows[0].quote?.price === 103);
    rows = service.state(false).rows;
    expect(rows[0].quote?.changePercent).toBeCloseTo(3); expect(rows[0].error).toBeUndefined();
    expect(connections).toBe(1); expect(service.state(false).connection).toBe('connected');
  } finally {
    service.stop(); for (const socket of server.clients) socket.terminate();
    await new Promise<void>(done => server.close(() => done()));
  }
});

it('updates overnight prices independently of an older regular timestamp on QUOTE', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(done => server.once('listening', done));
  const address = server.address(); if (typeof address === 'string') throw Error('Expected address');
  server.on('connection', socket => socket.on('message', raw => {
    const frame = JSON.parse(String(raw));
    if (frame.action === 'auth') socket.send(JSON.stringify({ session_id: 'fixture-session' }));
  }));
  const now = Date.parse('2026-11-02T08:00:00Z'); const regularTime = Date.parse('2026-10-30T20:00:00.359Z');
  let tickerPrice = 80; let tickerTime = now - 1000;
  const request: CloudRequest = async path => {
    if (path.endsWith('server-time')) return { server_time_ms: String(now) };
    if (path.endsWith('market-state')) return { data: { market_state_list: [{ code: 'US.SOXL', market_state: 'OVERNIGHT' }] } };
    if (path.includes('/rt-ticker?')) return { data: { last_close: 77.05, ticker_list: [{ price: tickerPrice, time: tickerTime, period_type: 'OVERNIGHT' }] } };
    return { data: { quote_list: [{ code: 'US.SOXL', last_price: 77.05, prev_close_price: 102.39, data_time: regularTime }] } };
  };
  const preferences = { ...DEFAULT_PREFERENCES, watchlist: [{ symbol: 'US.SOXL', name: 'SOXL', securityType: 4 }] };
  const service = new CloudQuoteService(preferences, () => undefined,
    { state: () => ({ status: 'authorized', remembered: false, message: '' }), token: async () => 'fixture-token' }, request,
    async () => { const socket = new WebSocket(`ws://127.0.0.1:${address.port}`); return { socket, release: () => socket.close() }; },
    { pollMs: 50, retryMs: [1000], refreshMs: 240000 });
  try {
    service.configure(preferences, ''); await until(() => ['connected', 'retrying'].includes(service.state(false).connection));
    expect(service.state(false).message).toBe('已连接富途云端');
    expect(service.state(false).rows[0].quote?.price).toBe(80);
    const push = (price: number, time: number, baseTime: number) => {
      for (const socket of server.clients) socket.send(JSON.stringify({ type: 'QUOTE', symbol: 'US.SOXL', data: {
        last_price: 77, prev_close_price: 100, data_time_ms: baseTime, overnight: { price, data_time_ms: time },
      } }));
    };
    push(80.91, now, regularTime - 1000);
    await until(() => service.state(false).rows[0].pushCount >= 1);
    expect(service.state(false).rows[0].quote).toMatchObject({ session: 'overnight', price: 80.91, baseline: 77.05, sourceEpoch: now });
    // A later regular anchor with stale extended content must not roll price back.
    push(1, now - 500, regularTime + 1000);
    await until(() => service.state(false).rows[0].pushCount >= 2);
    expect(service.state(false).rows[0].quote?.price).toBe(80.91);
    // If pushes stop, polling still advances the overnight quote.
    tickerPrice = 81; tickerTime = now + 1000;
    await until(() => service.state(false).rows[0].quote?.price === 81);
    expect(service.state(false).rows[0].quote?.baseline).toBe(77.05);
  } finally {
    service.stop(); for (const socket of server.clients) socket.terminate();
    await new Promise<void>(done => server.close(() => done()));
  }
});
