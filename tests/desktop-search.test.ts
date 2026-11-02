import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { DEFAULT_PREFERENCES } from '../src/shared/stock';
import { createGateway } from './gateway';

it.skipIf(process.env.STOCK_BAR_SEARCH_CHECK !== '1')('verifies search, keyboard/IME, offline behavior and additions in native Electron', async () => {
  const directoryItems = [
    { symbol: 'HK.00700', name: '騰訊控股', securityType: 3 }, { symbol: 'HK.09988', name: '阿里巴巴', securityType: 3 },
    { symbol: 'HK.02800', name: '盈富基金', securityType: 4 }, { symbol: 'US.AAPL', name: 'Apple Inc.', securityType: 3 },
    { symbol: 'US.BABA', name: 'Alibaba Group', securityType: 3 }, { symbol: 'US.NVDA', name: 'NVIDIA', securityType: 3 },
    { symbol: 'US.SPY', name: 'SPDR S&P 500 ETF', securityType: 4 },
  ];
  const gateway = await createGateway({ directoryItems, deniedCode: 'AAPL', invalidCode: 'MISSING' });
  const directory = resolve(process.env.STOCK_BAR_CHECK_OUTPUT || 'artifacts/search-fixture');
  const profile = resolve(directory, 'profile');
  await mkdir(profile, { recursive: true });
  await writeFile(resolve(profile, 'stock-bar-settings.json'), JSON.stringify({ version: 2, preferences: { ...DEFAULT_PREFERENCES, connectionMode: 'opend', port: gateway.port } }));
  // Each run tests a genuine first-load directory path instead of silently relying on previous evidence.
  const { rm } = await import('node:fs/promises');
  await rm(resolve(profile, 'security-directory.json'), { force: true });
  const control = createServer((request, response) => {
    const path = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    if (path === '/drop') { gateway.setAccepting(false); gateway.dropConnections(); }
    else if (path === '/directory-fail') gateway.setDirectoryFailure(11, true);
    else if (path === '/restore') { gateway.setAccepting(true); gateway.setDirectoryFailure(11, false); }
    else response.statusCode = 404;
    response.end('{}');
  });
  await new Promise<void>(done => control.listen(0, '127.0.0.1', done));
  const executable = process.env.STOCK_BAR_CHECK_EXECUTABLE;
  const child = spawn(executable || resolve('node_modules/electron/dist/electron.exe'), executable ? ['--search-check'] : ['.', '--search-check'], {
    cwd: resolve('.'), windowsHide: true, env: { ...process.env, STOCK_BAR_TEST_PROFILE: profile, STOCK_BAR_CHECK_OUTPUT: directory,
      STOCK_BAR_FIXTURE_CONTROL: `http://127.0.0.1:${(control.address() as AddressInfo).port}` }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const timer = setTimeout(() => child.kill(), 110000);
  try {
    const code = await new Promise<number | null>((done, reject) => { child.once('exit', done); child.once('error', reject); });
    expect(code, output).toBe(0);
    const report = JSON.parse(await readFile(resolve(directory, 'result.json'), 'utf8'));
    expect(report.passed).toBe(true); expect(report.checks.length).toBeGreaterThanOrEqual(25);
    const persisted = JSON.parse(await readFile(resolve(profile, 'security-directory.json'), 'utf8'));
    expect(persisted.markets.HK.items).toHaveLength(3); expect(persisted.markets.US.items).toHaveLength(4);
  } finally {
    clearTimeout(timer); child.kill(); await new Promise<void>(done => control.close(() => done())); await gateway.close();
  }
}, 120000);
