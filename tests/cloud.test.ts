import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { WebSocket } from 'undici';
import { expect, it } from 'vitest';
import { CloudAuth, matchesState } from '../src/main/cloud-auth';
import { CloudError, quoteScope, type CloudRequest } from '../src/main/cloud-api';
import { CloudQuoteService } from '../src/main/cloud-quotes';
import { SettingsStore } from '../src/main/settings';
import { DEFAULT_PREFERENCES } from '../src/shared/stock';

const cipher = { available: () => true, encrypt: (value: string) => Buffer.from(value.split('').reverse().join('')), decrypt: (value: Buffer) => value.toString().split('').reverse().join('') };
const until = async (predicate: () => boolean) => { const start = Date.now(); while (!predicate()) { if (Date.now() - start > 5000) throw Error('condition timed out'); await new Promise(done => setTimeout(done, 10)); } };
async function temporary() {
  const base = resolve('artifacts'); const { mkdir } = await import('node:fs/promises'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'cloud-test-'));
  return { file: join(directory, 'cloud.json'), cleanup: async () => {
    if (dirname(resolve(directory)) !== base) throw Error('Unsafe test cleanup');
    await rm(directory, { recursive: true });
  } };
}

it('runs official public-client PKCE, rejects wrong state, encrypts only refresh token and restores login', async () => {
  const temp = await temporary(); let authorize: URL | undefined; let callback = ''; let refreshes = 0;
  const request: CloudRequest = async (path, options = {}) => {
    if (path === '/oauth2/register') {
      const body = options.body; if (body instanceof URLSearchParams || !body) throw Error('Expected JSON');
      expect(body.scope).toBe('quote:read'); expect(body.token_endpoint_auth_method).toBe('none');
      callback = String((body.redirect_uris as string[])[0]); return { client_id: 'public-fixture-client' };
    }
    if (!(options.body instanceof URLSearchParams)) throw Error('Expected form');
    if (options.body.get('grant_type') === 'authorization_code') {
      expect(createHash('sha256').update(options.body.get('code_verifier')!).digest('base64url')).toBe(authorize!.searchParams.get('code_challenge'));
      expect(options.body.get('redirect_uri')).toBe(callback);
      return { access_token: 'fixture-access-secret', refresh_token: 'fixture-refresh-secret', expires_in: 7200, scope: 'quote:read accid:fixture-account' };
    }
    refreshes++; expect(options.body.get('refresh_token')).toBe('fixture-refresh-secret');
    return { access_token: 'fixture-renewed-secret', expires_in: 7200, scope: 'quote:read accid:fixture-account' };
  };
  const auth = new CloudAuth(temp.file, cipher, request, async url => { authorize = new URL(url); }, () => undefined, { port: 0, timeoutMs: 5000 });
  try {
    const login = auth.login(); await until(() => Boolean(authorize));
    expect(authorize!.origin).toBe('https://webapi.futunn.com');
    const wrong = new URL(callback); wrong.search = new URLSearchParams({ state: 'wrong', code: 'fixture-code' }).toString();
    expect((await fetch(wrong)).status).toBe(400); expect(auth.state().status).toBe('authorizing');
    const right = new URL(callback); right.search = new URLSearchParams({ state: authorize!.searchParams.get('state')!, code: 'fixture-code' }).toString();
    expect((await fetch(right)).status).toBe(200); await login;
    expect(auth.state()).toMatchObject({ status: 'authorized', remembered: true });
    const saved = await readFile(temp.file, 'utf8');
    for (const secret of ['fixture-access-secret', 'fixture-refresh-secret', 'fixture-account', 'fixture-code']) expect(saved).not.toContain(secret);
    const restored = new CloudAuth(temp.file, cipher, request, async () => undefined, () => undefined);
    await restored.load(); expect(restored.state().status).toBe('authorized');
    const values = await Promise.all([restored.token(), restored.token()]);
    expect(values).toEqual(['fixture-renewed-secret', 'fixture-renewed-secret']); expect(refreshes).toBe(1);
    await restored.logout(); expect(restored.state().status).toBe('signedOut');
    expect(JSON.parse(await readFile(temp.file, 'utf8')).encryptedRefresh).toBeUndefined();
    restored.stop();
  } finally { auth.stop(); await temp.cleanup(); }
});

it('cancelled authorization cannot accept a late callback or persist credentials', async () => {
  const temp = await temporary(); let url: URL | undefined;
  const auth = new CloudAuth(temp.file, cipher, async () => ({ client_id: 'fixture-client' }), async value => { url = new URL(value); }, () => undefined, { port: 0, timeoutMs: 5000 });
  try {
    const login = auth.login(); const rejected = expect(login).rejects.toThrow('已取消');
    await until(() => Boolean(url)); auth.cancelLogin(); await rejected;
    expect(auth.state().status).toBe('signedOut'); expect(JSON.parse(await readFile(temp.file, 'utf8')).encryptedRefresh).toBeUndefined();
  } finally { auth.stop(); await temp.cleanup(); }
});

it('validates OAuth state and least privilege without accepting multibyte or broader scopes', () => {
  expect(matchesState('a'.repeat(43), 'a'.repeat(43))).toBe(true);
  expect(matchesState('中'.repeat(43), 'a'.repeat(43))).toBe(false);
  expect(quoteScope('quote:read accid:123')).toBe(true);
  for (const scope of ['', 'quote:read trade:read', 'quote:read quote:write', 'quote:read admin:*']) expect(quoteScope(scope)).toBe(false);
});

it('a token refresh completing after logout cannot restore the old account', async () => {
  const temp = await temporary(); const { writeFile } = await import('node:fs/promises');
  let complete: ((value: Record<string, unknown>) => void) | undefined;
  await writeFile(temp.file, JSON.stringify({ clientId: 'fixture-client', encryptedRefresh: cipher.encrypt('fixture-refresh').toString('base64') }));
  const auth = new CloudAuth(temp.file, cipher, async () => new Promise(done => { complete = done; }), async () => undefined, () => undefined);
  try {
    await auth.load(); const pending = auth.token(); const rejected = expect(pending).rejects.toThrow('已取消');
    await until(() => Boolean(complete)); await auth.logout();
    complete!({ access_token: 'late-old-account-token', refresh_token: 'late-refresh', scope: 'quote:read', expires_in: 7200 });
    await rejected; expect(auth.state().status).toBe('signedOut');
    expect(JSON.parse(await readFile(temp.file, 'utf8')).encryptedRefresh).toBeUndefined();
  } finally { auth.stop(); await temp.cleanup(); }
});

it('defaults to cloud when migrating old settings and preserves the OpenD backup', async () => {
  const temp = await temporary(); const { writeFile } = await import('node:fs/promises');
  try {
    const { connectionMode: _unused, ...old } = DEFAULT_PREFERENCES;
    await writeFile(temp.file, JSON.stringify({ version: 2, preferences: { ...old, port: 34567, watchlist: [{ symbol: 'US.AAPL', name: 'Apple', securityType: 3 }] } }));
    const store = new SettingsStore(temp.file, cipher); await store.load();
    expect(store.preferences).toMatchObject({ connectionMode: 'cloud', port: 34567, watchlist: [{ symbol: 'US.AAPL' }] });
    await store.setConnection({ host: 'localhost', port: 34567, ssl: false, rememberKey: true, key: 'fixture-opend-key' });
    expect(store.preferences.connectionMode).toBe('opend');
    store.preferences.connectionMode = 'cloud'; await store.save();
    const loaded = new SettingsStore(temp.file, cipher); await loaded.load();
    expect(loaded.preferences.connectionMode).toBe('cloud'); expect(loaded.preferences.port).toBe(34567); expect(loaded.key).toBe('fixture-opend-key');
  } finally { await temp.cleanup(); }
});

it('receives real WebSocket protocol frames without a subscription acknowledgement and preserves source time across reconnect', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(done => server.once('listening', done));
  const address = server.address(); if (typeof address === 'string') throw Error('Expected IP address');
  const now = Date.parse('2026-10-23T21:00:00Z'); const baseTime = now - 3600000; let connections = 0; let refreshes = 0;
  server.on('connection', socket => { connections++; socket.on('message', raw => {
    const frame = JSON.parse(String(raw));
    if (frame.action === 'auth' || frame.action === 'refresh') { if (frame.action === 'refresh') refreshes++; socket.send(JSON.stringify({ id: frame.id, session_id: 'fixture-session' })); }
    if (frame.action === 'subscribe') socket.send(JSON.stringify({ type: 'QUOTE', symbol: 'US.AAPL', data: { last_price: 100, prev_close_price: 90,
      data_time_ms: baseTime, after_market: { price: 101, data_time_ms: now } } }));
  }); });
  const request: CloudRequest = async path => path.endsWith('server-time') ? { server_time_ms: String(now) }
    : { data: path.endsWith('market-state') ? { market_state_list: [{ code: 'US.AAPL', market_state: 'AFTER_HOURS_BEGIN' }] }
      : path.endsWith('stock-basicinfo') ? { basic_list: [{ code: 'US.AAPL', sc_name: '苹果', stock_type: 'STOCK', state: 'NORMAL' }] }
        : { quote_list: [{ code: 'US.AAPL', last_price: 100, prev_close_price: 90, data_time: baseTime }] } };
  const preferences = { ...DEFAULT_PREFERENCES, watchlist: [{ symbol: 'US.AAPL', name: 'Apple', securityType: 3 }] };
  const auth = { state: () => ({ status: 'authorized' as const, remembered: true, message: '' }), token: async () => 'fixture-only-token' };
  const service = new CloudQuoteService(preferences, () => undefined, auth, request, async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`); return { socket, release: () => socket.close() };
  }, { pollMs: 30, retryMs: [30], refreshMs: 60 });
  try {
    service.configure(preferences, 'ignored-opend-key'); await until(() => service.state(false).connection === 'connected');
    await until(() => service.state(false).rows[0].quote?.price === 101);
    expect(service.state(false).rows[0].quote).toMatchObject({ session: 'after', sourceEpoch: now });
    expect(service.state(false).rows[0].quote?.changePercent).toBeCloseTo(1);
    expect(await service.lookup('US.AAPL')).toEqual({ symbol: 'US.AAPL', name: '苹果', securityType: 3 });
    await until(() => refreshes >= 1);
    for (const socket of server.clients) socket.close();
    await until(() => connections >= 2 && service.state(false).connection === 'connected');
    expect(service.state(false).rows[0].quote?.sourceEpoch).toBe(now);
    service.suspend(); expect(service.state(false).rows[0].quote?.price).toBe(101);
    service.reconnect(); await until(() => connections >= 3 && service.state(false).connection === 'connected');
  } finally { service.stop(); for (const socket of server.clients) socket.terminate(); await new Promise<void>(done => server.close(() => done())); }
});

it('does not retry a signed-out cloud session or expose OpenD keys in cloud state', async () => {
  let calls = 0;
  const service = new CloudQuoteService(DEFAULT_PREFERENCES, () => undefined,
    { state: () => ({ status: 'signedOut', remembered: false, message: '' }), token: async () => { calls++; throw new CloudError('请登录', undefined, true); } },
    async () => { calls++; return {}; }, async () => { throw Error('must not connect'); });
  service.configure(DEFAULT_PREFERENCES, 'secret-backup-key');
  expect(service.state(true)).toMatchObject({ connection: 'disconnected', keyInSession: false });
  expect(calls).toBe(0); service.stop();
});

it('keeps large watchlists and selections on a quota failure, then recovers all quotes without reconnecting for selection changes', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(done => server.once('listening', done));
  const address = server.address(); if (typeof address === 'string') throw Error('Expected address');
  let connections = 0; let deny = true; let subscribed: string[] = [];
  server.on('connection', socket => { connections++; socket.on('message', raw => {
    const frame = JSON.parse(String(raw));
    if (frame.action === 'auth') socket.send(JSON.stringify({ session_id: 'fixture-session' }));
    if (frame.action === 'subscribe') subscribed = frame.quote;
  }); });
  const now = Date.parse('2026-10-23T06:30:00Z');
  const preferences = { ...DEFAULT_PREFERENCES, watchlist: Array.from({ length: 25 }, (_, index) => ({
    symbol: `HK.${String(index + 1).padStart(5, '0')}`, name: `证券${index}`, securityType: 3, showInBar: index < 2,
  })) };
  const request: CloudRequest = async (path, options) => {
    if (path.endsWith('server-time')) return { server_time_ms: String(now) };
    expect(options?.body).toEqual({ code_list: preferences.watchlist.map(item => item.symbol) });
    if (deny) throw new CloudError('行情数量或额度受限', -9);
    return path.endsWith('market-state') ? { data: { market_state_list: [] } }
      : { data: { quote_list: preferences.watchlist.map(item => ({ code: item.symbol, last_price: 100, prev_close_price: 99, data_time: now })) } };
  };
  const service = new CloudQuoteService(preferences, () => undefined,
    { state: () => ({ status: 'authorized', remembered: false, message: '' }), token: async () => 'fixture-token' }, request,
    async () => { const socket = new WebSocket(`ws://127.0.0.1:${address.port}`); return { socket, release: () => socket.close() }; },
    { pollMs: 100, retryMs: [10000], refreshMs: 240000 });
  try {
    service.configure(preferences, ''); await until(() => service.state(false).connection === 'retrying');
    expect(service.state(false).preferences.watchlist).toEqual(preferences.watchlist);
    expect(service.state(false).rows).toHaveLength(25);
    expect(service.state(false).rows.every(row => row.error === '行情数量或额度受限')).toBe(true);
    deny = false; service.reconnect(); await until(() => service.state(false).connection === 'connected');
    expect(service.state(false).rows.every(row => row.quote?.price === 100 && !row.error)).toBe(true);
    await until(() => subscribed.length === 25);
    const previousConnections = connections;
    service.configure({ ...preferences, watchlist: preferences.watchlist.map(item => ({ ...item, showInBar: false })) }, '');
    expect(service.state(false).preferences.watchlist.every(item => item.showInBar === false)).toBe(true);
    expect(service.diagnostics().basicSubscriptions).toBe(25);
    expect(connections).toBe(previousConnections);
  } finally { service.stop(); for (const socket of server.clients) socket.terminate(); await new Promise<void>(done => server.close(() => done())); }
});

it('backfills missing A-share quotes from snapshots and isolates snapshot failures from healthy quotes', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(done => server.once('listening', done));
  const address = server.address(); if (typeof address === 'string') throw Error('Expected address');
  server.on('connection', socket => socket.on('message', raw => {
    const frame = JSON.parse(String(raw));
    if (frame.action === 'auth') socket.send(JSON.stringify({ session_id: 'fixture-session' }));
  }));
  const now = Date.parse('2026-10-23T06:30:00Z'); let deny = false;
  const preferences = { ...DEFAULT_PREFERENCES, watchlist: [
    { symbol: 'HK.00700', name: '腾讯', securityType: 3 }, { symbol: 'SH.600519', name: '贵州茅台', securityType: 3 },
    { symbol: 'SZ.000001', name: '平安银行', securityType: 3 },
  ] };
  const request: CloudRequest = async (path, options) => {
    if (path.endsWith('server-time')) return { server_time_ms: String(now) };
    if (path.endsWith('market-state')) return { data: { market_state_list: preferences.watchlist.map(item => ({ code: item.symbol, market_state: item.symbol.startsWith('SH.') ? 'STIB_AFTER_HOURS_END' : 'AFTERNOON' })) } };
    if (path.endsWith('snapshot')) {
      expect(options?.body).toEqual({ code_list: ['SH.600519', 'SZ.000001'] });
      if (deny) throw new CloudError('快照权限不足', -9);
      return { data: { snapshot_list: [{ code: 'SH.600519', last_price: 1500, prev_close_price: 1480, update_time: now }] } };
    }
    return { data: { quote_list: [{ code: 'HK.00700', last_price: 400, prev_close_price: 395, data_time: now }] } };
  };
  const service = new CloudQuoteService(preferences, () => undefined,
    { state: () => ({ status: 'authorized', remembered: false, message: '' }), token: async () => 'fixture-token' }, request,
    async () => { const socket = new WebSocket(`ws://127.0.0.1:${address.port}`); return { socket, release: () => socket.close() }; });
  try {
    service.configure(preferences, ''); await until(() => service.state(false).connection === 'connected');
    let rows = service.state(false).rows;
    expect(rows[0].quote?.price).toBe(400); expect(rows[0].error).toBeUndefined();
    expect(rows[1].quote).toMatchObject({ price: 1500, sourceEpoch: now, sourceZone: 'Asia/Shanghai' });
    expect(rows[1].status).toBe('休市 · 快照'); expect(rows[1].timeliness).toBe('unknown');
    expect(rows[2].error).toContain('未返回报价或快照');
    deny = true; service.reconnect(); await until(() => service.state(false).connection === 'connected');
    rows = service.state(false).rows;
    expect(rows[0].error).toBeUndefined(); expect(rows[0].quote?.price).toBe(400);
    expect(rows[1].error).toBe('快照权限不足'); expect(rows[1].quote?.price).toBe(1500);
  } finally { service.stop(); for (const socket of server.clients) socket.terminate(); await new Promise<void>(done => server.close(() => done())); }
});
