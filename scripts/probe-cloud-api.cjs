// Independent Futu cloud probe. Does not load Electron settings or connect to OpenD.
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { fetch, ProxyAgent, WebSocket } = require('undici');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts', 'cloud-api-probe.json');
const clientFile = path.join(root, '.cache', 'cloud-oauth-client.local.json');
const api = 'https://webapi.futunn.com';
const quoteWs = 'wss://webapi-quote.futunn.com/ws';
const redirectUri = 'http://127.0.0.1:60355/callback';
const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
const report = { startedAt: new Date().toISOString(), transport: proxy ? 'system HTTP proxy' : 'direct HTTPS',
  openDUsed: false, checks: [], authenticatedAccount: 'not tested', quoteData: 'not tested' };

async function record(name, value) {
  const safe = { ...value };
  for (const key of ['scope', 'returnedScope']) {
    if (typeof safe[key] === 'string') safe[key] = redactScope(safe[key]);
  }
  report.checks.push({ name, ...safe });
  console.log(JSON.stringify({ name, ...safe }));
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
}

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, dispatcher, redirect: 'manual', signal: AbortSignal.timeout(20000) });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  return { status: response.status, contentType: response.headers.get('content-type'), data,
    redirect: response.headers.get('location'), bytes: Buffer.byteLength(text) };
}

// Summaries deliberately exclude raw responses, credentials, account IDs and cookies.
function summary(response) {
  return { status: response.status, contentType: response.contentType, bytes: response.bytes,
    jsonKeys: response.data && typeof response.data === 'object' ? Object.keys(response.data) : [],
    errorCode: response.data?.error ?? response.data?.code ?? response.data?.ret_code ?? response.data?.retcode ?? null };
}

function redactScope(scope) { return scope.replace(/\baccid:[^\s]+/g, 'accid:<redacted>'); }

function validState(actual, expected) {
  const left = Buffer.from(actual); const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function readOnlyScope(scope) {
  const scopes = String(scope || '').split(/\s+/);
  return scopes.includes('quote:read') && scopes.every(value => value === 'quote:read' || /^accid:[^\s]+$/.test(value));
}

async function register() {
  try {
    const cached = JSON.parse(await fs.readFile(clientFile, 'utf8'));
    if (typeof cached.client_id === 'string' && cached.redirect_uri === redirectUri) {
      await record('oauth-registration', { status: 'cached public client', requestedScope: 'quote:read' });
      return cached;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await request(`${api}/oauth2/register`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      client_name: 'Stock Bar Cloud Read-only Probe', scope: 'quote:read' }) });
  await record('oauth-registration', { ...summary(response), requestedScope: 'quote:read',
    clientIdReceived: typeof response.data?.client_id === 'string', returnedScope: response.data?.scope,
    pkceRequired: response.data?.pkce_required });
  if (![200, 201].includes(response.status) || typeof response.data?.client_id !== 'string') return null;
  // The client ID is public. Discard the registration access token; never persist it.
  const client = { client_id: response.data.client_id, redirect_uri: redirectUri };
  await fs.mkdir(path.dirname(clientFile), { recursive: true });
  await fs.writeFile(clientFile, JSON.stringify(client, null, 2) + '\n');
  return client;
}

async function socketControl() {
  return new Promise(resolve => {
    const ws = new WebSocket(quoteWs, { dispatcher });
    const result = { opened: false, responseReceived: false };
    let done = false;
    const timeout = setTimeout(() => finish({ timedOut: true }), 18000);
    function finish(extra) {
      if (done) return;
      done = true; clearTimeout(timeout);
      if (ws.readyState < 2) ws.close();
      resolve({ ...result, ...extra });
    }
    ws.addEventListener('open', () => {
      result.opened = true;
      // Negative control: invalid credential only, never connects to a real account.
      ws.send(JSON.stringify({ id: 'negative-control', action: 'auth',
        data: { auth_type: 'oauth2', authorization: 'Bearer stock-bar-invalid-probe-token' } }));
    });
    ws.addEventListener('message', event => {
      result.responseReceived = true;
      let value; try { value = JSON.parse(String(event.data)); } catch { value = {}; }
      finish({ jsonKeys: Object.keys(value), errorCode: value.error?.code ?? value.code ?? value.error_code ?? null });
    });
    ws.addEventListener('error', () => finish({ networkError: true }));
    ws.addEventListener('close', event => finish({ closeCode: event.code }));
  });
}

async function authorize(client) {
  const state = crypto.randomBytes(32).toString('base64url');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const url = new URL(`${api}/oauth2/authorize/confirm`);
  url.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirectUri,
    response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge, state,
    scope: 'quote:read' }).toString();
  return new Promise((resolve, reject) => {
    let consumed = false;
    const server = http.createServer((req, res) => { void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end('Authorization probe failed. Return to Codex for the result.');
      finish(new Error('OAuth callback failed'));
    }); });
    const timeout = setTimeout(() => finish(new Error('OAuth login timed out after 20 minutes')), 20 * 60000);
    function finish(error, token) {
      clearTimeout(timeout); server.close();
      if (error) reject(error); else resolve(token);
    }
    function page(res, status, body) {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
      res.end(`<!doctype html><meta charset="utf-8"><title>富途云端接入验证</title><style>body{font:18px system-ui;max-width:720px;margin:70px auto;padding:24px;line-height:1.8}a{color:#1769cf}</style>${body}`);
    }
    async function handle(req, res) {
      if (req.headers.host !== '127.0.0.1:60355' || req.method !== 'GET') {
        res.writeHead(403); res.end(); return;
      }
      const parsed = new URL(req.url, redirectUri);
      if (parsed.pathname === '/') {
        page(res, 200, '<h1>富途云端行情验证</h1><p>点击下方链接，前往富途官方页面登录授权。仅请求行情读取，不请求交易权限。密码和验证码只在富途官方页面输入。</p><p><a href="/authorize">前往富途官方页面授权</a></p><p>本次令牌仅保存在验证进程内存，关闭后不保留。验证样本：腾讯 HK.00700、苹果 US.AAPL。</p>');
        return;
      }
      if (parsed.pathname === '/authorize' && !consumed) {
        res.writeHead(302, { Location: url.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        res.end(); return;
      }
      if (parsed.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      const returnedState = parsed.searchParams.get('state') || '';
      if (!validState(returnedState, state)) {
        page(res, 400, '<p>授权状态校验失败，未交换令牌。请返回 Codex。</p>'); return;
      }
      if (consumed) { page(res, 409, '<p>该授权回调已处理。</p>'); return; }
      consumed = true;
      if (parsed.searchParams.has('error')) {
        page(res, 400, '<p>富途授权未完成，请返回 Codex 查看结果。</p>');
        await record('oauth-callback', { status: 'authorization denied', stateValidated: true });
        finish(new Error('OAuth authorization denied')); return;
      }
      const code = parsed.searchParams.get('code');
      if (!code) { page(res, 400, '<p>未收到授权码。</p>'); finish(new Error('Missing authorization code')); return; }
      const token = await request(`${api}/oauth2/token`, { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: client.client_id,
          redirect_uri: redirectUri, code_verifier: verifier }).toString() });
      await record('oauth-token-exchange', { ...summary(token), stateValidated: true,
        accessTokenReceived: typeof token.data?.access_token === 'string', scope: token.data?.scope,
        expiresIn: token.data?.expires_in, refreshTokenReceived: typeof token.data?.refresh_token === 'string' });
      if (token.status !== 200 || typeof token.data?.access_token !== 'string') {
        page(res, 400, '<p>令牌交换失败，请返回 Codex 查看结果。</p>');
        finish(new Error('Token exchange failed')); return;
      }
      if (!readOnlyScope(token.data.scope)) {
        page(res, 400, '<p>返回权限与仅行情读取的验证目标不符，已停止后续请求。</p>');
        finish(new Error('Unexpected OAuth scope')); return;
      }
      page(res, 200, '<h1>授权成功</h1><p>正在自动验证港美股报价、实时订阅与令牌刷新。请返回 Codex 查看结果，可以关闭此页。</p>');
      finish(null, token.data);
    }
    server.once('error', error => finish(error));
    server.listen(60355, '127.0.0.1', () => {
      void record('oauth-awaiting-user', { localEntry: 'http://127.0.0.1:60355/',
        officialAuthorizationOrigin: new URL(url).origin, requestedScope: 'quote:read', timeoutMinutes: 20 });
    });
  });
}

function quoteSummary(quote, ws = false) {
  // Public market data only; explicitly allowlist persisted fields.
  const result = {};
  for (const key of ['code', 'symbol', 'name', 'last_price', 'prev_close_price', ws ? 'data_time_ms' : 'data_time']) {
    if (typeof quote[key] === 'string' || typeof quote[key] === 'number') result[key] = quote[key];
  }
  for (const key of ['pre_market', 'after_market', 'overnight']) {
    if (quote[key] && typeof quote[key] === 'object') {
      result[key] = Object.fromEntries(['price', 'last_price', 'change_val', 'change_rate', 'data_time', 'data_time_ms']
        .filter(field => typeof quote[key][field] === 'number' || typeof quote[key][field] === 'string')
        .map(field => [field, quote[key][field]]));
    }
  }
  return result;
}

async function authorizedSocket(token) {
  return new Promise(resolve => {
    const ws = new WebSocket(quoteWs, { dispatcher });
    const started = Date.now();
    const result = { opened: false, authenticated: false, subscriptionAccepted: null, quoteFrames: 0,
      quotes: {}, targetObservationSeconds: 45, freshUpdatesNotGuaranteedOutsideMarketHours: true, frameShapes: [] };
    let done = false;
    let subscribed = false;
    let observationTimer;
    const timeout = setTimeout(() => finish({ timedOut: true }), 15000);
    function finish(extra) {
      if (done) return;
      done = true; clearTimeout(timeout); clearTimeout(observationTimer);
      if (ws.readyState === 1 && subscribed) ws.send(JSON.stringify({ id: 'cloud-probe-unsubscribe',
        action: 'unsubscribe', quote: ['HK.00700', 'US.AAPL'] }));
      if (ws.readyState < 2) ws.close();
      resolve({ ...result, ...extra, elapsedSeconds: Math.round((Date.now() - started) / 100) / 10 });
    }
    ws.addEventListener('open', () => {
      result.opened = true;
      ws.send(JSON.stringify({ id: 'cloud-probe-auth', action: 'auth',
        data: { auth_type: 'oauth2', authorization: `Bearer ${token}` } }));
    });
    ws.addEventListener('message', event => {
      let frame; try { frame = JSON.parse(String(event.data)); } catch { finish({ invalidJson: true }); return; }
      const shape = Object.keys(frame).sort().join(',');
      if (!result.frameShapes.includes(shape)) result.frameShapes.push(shape);
      if (frame.id === 'cloud-probe-auth') {
        if (typeof frame.session_id !== 'string' || (frame.code !== undefined && frame.code !== 0)) {
          finish({ authErrorCode: frame.code ?? null }); return;
        }
        result.authenticated = true;
        clearTimeout(timeout);
        observationTimer = setTimeout(() => finish({ observationCompleted: true }), 45000);
        subscribed = true;
        ws.send(JSON.stringify({ id: 'cloud-probe-subscribe', action: 'subscribe', quote: ['HK.00700', 'US.AAPL'] }));
      } else if (frame.id === 'cloud-probe-subscribe') {
        result.subscriptionAccepted = frame.code === 0;
        result.subscriptionCode = frame.code ?? null;
        if (!result.subscriptionAccepted) { finish({}); return; }
      } else if (frame.type === 'QUOTE' && ['HK.00700', 'US.AAPL'].includes(frame.symbol)) {
        result.quoteFrames++;
        result.quotes[frame.symbol] = quoteSummary(frame.data || {}, true);
      } else if (frame.code && frame.code !== 0) finish({ serverErrorCode: frame.code });
    });
    ws.addEventListener('error', () => finish({ networkError: true }));
    ws.addEventListener('close', event => finish({ closeCode: event.code }));
  });
}

async function accountProbe(client) {
  const token = await authorize(client);
  report.authenticatedAccount = 'official OAuth callback and token exchange succeeded';
  const quotes = await request(`${api}/api/v1.0/quote/stock-quote`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token.access_token}` },
    body: JSON.stringify({ code_list: ['HK.00700', 'US.AAPL'] }) });
  const list = Array.isArray(quotes.data?.data?.quote_list) ? quotes.data.data.quote_list : [];
  report.quoteData = list.length ? 'REST market data received; inspect source timestamps' : 'not received';
  await record('authorized-rest-quotes', { ...summary(quotes), quoteCount: list.length, quotes: list.map(quote => quoteSummary(quote)) });
  if (typeof token.refresh_token === 'string') {
    const refreshed = await request(`${api}/oauth2/token`, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token,
        client_id: client.client_id }).toString() });
    await record('oauth-token-refresh', { ...summary(refreshed), accessTokenReceived: typeof refreshed.data?.access_token === 'string',
      scope: refreshed.data?.scope, expiresIn: refreshed.data?.expires_in });
    if (refreshed.status === 200 && typeof refreshed.data?.access_token === 'string') {
      if (!readOnlyScope(refreshed.data.scope)) throw new Error('Unexpected refreshed OAuth scope');
      token.access_token = refreshed.data.access_token;
    }
  }
  await record('authorized-websocket-quotes', await authorizedSocket(token.access_token));
}

async function main() {
  const time = await request(`${api}/api/v1.0/server-time`);
  await record('server-time', { ...summary(time), validTime: /^\d{13}$/.test(String(time.data?.server_time_ms)) });
  const negative = await request(`${api}/api/v1.0/quote/stock-quote`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code_list: ['HK.00700', 'US.AAPL'] }) });
  await record('rest-without-credentials', summary(negative));
  await record('websocket-invalid-token', await socketControl());
  if (process.argv.includes('--register') || process.argv.includes('--authorize')) {
    const client = await register();
    if (process.argv.includes('--authorize') && client) await accountProbe(client);
  }
}

if (require.main === module) {
  main().catch(async error => {
    await record('probe-error', { type: error.name, code: error.cause?.code || error.code || null });
    process.exitCode = 1;
  }).finally(async () => { if (dispatcher) await dispatcher.close(); });
}

module.exports = { validState, readOnlyScope, redactScope, quoteSummary };
