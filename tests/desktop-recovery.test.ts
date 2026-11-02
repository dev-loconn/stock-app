import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { DEFAULT_PREFERENCES } from '../src/shared/stock';
import { createGateway } from './gateway';

// Explicit native integration suite: build first, then npm run test:recovery.
it.skipIf(process.env.STOCK_BAR_NATIVE_CHECK !== '1')('validates recovery and ten-symbol receipt-to-frame latency in native Electron', async () => {
  const gateway = await createGateway();
  const outputDirectory = resolve(process.env.STOCK_BAR_CHECK_OUTPUT || 'artifacts/recovery-fixture');
  const watchlist = Array.from({ length: 10 }, (_, index) => ({ symbol: `HK.${String(index + 1).padStart(5, '0')}`, name: `FIXTURE ${index}`, securityType: 3 }));
  const profile = resolve(outputDirectory, 'profile');
  await mkdir(profile, { recursive: true });
  await writeFile(resolve(profile, 'stock-bar-settings.json'), JSON.stringify({ version: 1, preferences: { ...DEFAULT_PREFERENCES, connectionMode: 'opend', port: gateway.port, watchlist } }));
  const control = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/push') {
      gateway.pushQuotes(watchlist.map(item => ({ market: 1, code: item.symbol.slice(3) })), Number(url.searchParams.get('price')));
      response.end('{}');
    } else if (url.pathname === '/stats') {
      const subscriptions = gateway.calls.filter(call => call.cmd === 3001);
      const perConnection = [...new Set(subscriptions.map(call => call.connection))].map(connection => ({ connection,
        subscriptions: subscriptions.filter(call => call.connection === connection).length,
        unique: new Set(subscriptions.filter(call => call.connection === connection).map(call => JSON.stringify(call.c2s.securityList))).size }));
      response.end(JSON.stringify({ connections: gateway.connections(), open: gateway.openConnections(), perConnection }));
    } else { response.writeHead(404); response.end('{}'); }
  });
  await new Promise<void>(done => control.listen(0, '127.0.0.1', done));
  const port = (control.address() as AddressInfo).port;
  const executable = process.env.STOCK_BAR_CHECK_EXECUTABLE;
  const child = spawn(executable || resolve('node_modules/electron/dist/electron.exe'), executable ? ['--recovery-check'] : ['.', '--recovery-check'], {
    cwd: resolve('.'), windowsHide: true, env: { ...process.env, STOCK_BAR_TEST_PROFILE: profile, STOCK_BAR_FIXTURE_CONTROL: `http://127.0.0.1:${port}`, STOCK_BAR_SOAK_MS: '60000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const timer = setTimeout(() => child.kill(), 110000);
  try {
    const code = await new Promise<number | null>((done, reject) => { child.once('exit', done); child.once('error', reject); });
    expect(code, output).toBe(0);
    const report = JSON.parse(await readFile(resolve(outputDirectory, 'result.json'), 'utf8'));
    expect(report.passed).toBe(true);
    expect(report.latency.symbols).toBe(10);
    expect(report.latency.maxMs).toBeLessThanOrEqual(1000);
    expect(report.latency.samples).toHaveLength(30);
    expect(report.offlineStart).toMatchObject({ noCachedPrices: true, symbolsRestored: 10 });
    expect(report.soak.durationMs).toBeGreaterThanOrEqual(60000);
    expect(report.fixture.open).toBe(1);
    expect(report.fixture.perConnection.every((entry: {subscriptions: number; unique: number}) => entry.subscriptions === 10 && entry.unique === 10)).toBe(true);
  } finally {
    clearTimeout(timer); child.kill();
    await new Promise<void>(done => control.close(() => done()));
    await gateway.close();
  }
}, 120000);
