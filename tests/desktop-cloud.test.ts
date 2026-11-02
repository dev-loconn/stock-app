import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { expect, it } from 'vitest';
import { DEFAULT_PREFERENCES } from '../src/shared/stock';
import { createGateway } from './gateway';

it.skipIf(process.env.STOCK_BAR_CLOUD_CHECK !== '1')('runs native OAuth, cloud quotes, encrypted storage and both provider switches', async () => {
  const directory = resolve('artifacts/cloud-desktop'); const profile = resolve(directory, 'profile'); await mkdir(profile, { recursive: true });
  const gateway = await createGateway();
  await writeFile(resolve(profile, 'stock-bar-settings.json'), JSON.stringify({ version: 2, preferences: { ...DEFAULT_PREFERENCES, port: gateway.port,
    watchlist: [{ symbol: 'US.AAPL', name: '苹果', securityType: 3 }] } }));
  await writeFile(resolve(profile, 'stock-bar-cloud.json'), '{}');
  const now = Date.parse('2026-10-23T04:01:00Z');
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
      const body = raw.startsWith('{') ? JSON.parse(raw) : {};
      const names: Record<string, string> = { 'US.SOXL': '三倍做多半导体', 'US.AAPL': '苹果', 'HK.00700': '腾讯控股', 'SH.600519': '贵州茅台', 'SZ.000001': '平安银行', 'BJ.920001': '纬达光电' };
      const prices: Record<string, number> = { 'US.SOXL': 100, 'US.AAPL': 232, 'HK.00700': 400, 'SH.600519': 1500, 'SZ.000001': 12, 'BJ.920001': 10 };
      const codes: string[] = body.code_list || [];
      const value = req.url === '/oauth2/register' ? { client_id: 'fixture-client' }
        : req.url === '/oauth2/token' ? { access_token: 'fixture-access', refresh_token: 'fixture-refresh', scope: 'quote:read accid:fixture-account', expires_in: 7200 }
          : req.url?.startsWith('/directory/') ? { items: Object.keys(names).filter(code => code.startsWith(req.url!.split('/').at(-1) + '.')).map(symbol => ({ symbol, name: names[symbol], securityType: 0, aliases: symbol === 'HK.00700' ? ['Tencent Holdings'] : [] })) }
          : req.url?.endsWith('server-time') ? { server_time_ms: String(now) }
            : { data: req.url?.includes('/US.SOXL/rt-ticker?') ? { code: 'US.SOXL', last_close: 100, ticker_list: [{ price: 103, time: now - 1000, period_type: 'OVERNIGHT' }] }
              : req.url?.endsWith('market-state') ? { market_state_list: codes.map(code => ({ code, market_state: code === 'US.SOXL' ? 'OVERNIGHT' : 'CLOSED' })) }
              : req.url?.endsWith('stock-basicinfo') ? { basic_list: codes.filter(code => names[code]).map(code => ({ code, sc_name: names[code], stock_type: 'STOCK', state: 'NORMAL' })) }
                : { quote_list: codes.filter(code => prices[code]).map(code => ({ code, last_price: prices[code], prev_close_price: prices[code] / 1.01, data_time: code === 'US.SOXL' ? now - 8 * 3600000 : now })) } };
      res.end(JSON.stringify(value));
    });
  });
  const ws = new WebSocketServer({ server });
  ws.on('connection', socket => socket.on('message', raw => {
    const data = JSON.parse(String(raw));
    if (data.action === 'auth' || data.action === 'refresh') socket.send(JSON.stringify({ id: data.id, session_id: 'fixture-session' }));
    if (data.action === 'subscribe') socket.send(JSON.stringify({ type: 'QUOTE', symbol: 'US.AAPL', data: { last_price: 232, prev_close_price: 230, data_time_ms: now } }));
  }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Expected IP address');
  const executable = process.env.STOCK_BAR_CHECK_EXECUTABLE;
  const child = spawn(executable || resolve('node_modules/electron/dist/electron.exe'), executable ? ['--cloud-check'] : ['.', '--cloud-check'], {
    cwd: resolve('.'), windowsHide: true, env: { ...process.env, STOCK_BAR_TEST_PROFILE: profile, STOCK_BAR_CHECK_OUTPUT: directory,
      STOCK_BAR_CLOUD_FIXTURE: `http://127.0.0.1:${address.port}` }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const timer = setTimeout(() => child.kill(), 60000);
  try {
    const code = await new Promise<number | null>((done, reject) => { child.once('exit', done); child.once('error', reject); });
    expect(code, output).toBe(0); const report = JSON.parse(await readFile(resolve(directory, 'result.json'), 'utf8'));
    expect(report.passed).toBe(true); expect(report.checks.length).toBeGreaterThanOrEqual(10);
  } finally {
    clearTimeout(timer); child.kill(); for (const socket of ws.clients) socket.terminate();
    await new Promise<void>(done => ws.close(() => done())); await new Promise<void>(done => server.close(() => done())); await gateway.close();
  }
}, 75000);
