import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { DEFAULT_PREFERENCES } from '../src/shared/stock';
import { createGateway } from './gateway';

it.skipIf(process.env.STOCK_BAR_LAYOUT_CHECK !== '1')('validates fixed widths, pagination and the live overview in native Electron', async () => {
  const gateway = await createGateway({ directoryItems: [
    { symbol: 'US.SOXL', name: '三倍做多半导体测试', securityType: 4 },
    { symbol: 'US.SOXS', name: '不含方向特征的测试名称', securityType: 4 },
    { symbol: 'US.TQQQ', name: '三倍做多纳指测试', securityType: 4 },
    { symbol: 'US.DISPLAYTEST', name: 'Daily 2x Test ETF', securityType: 4 },
    { symbol: 'US.DISPLAYPLAIN', name: '普通指数基金测试', securityType: 4 },
    { symbol: 'HK.09999', name: '三倍做多港股测试', securityType: 4 },
  ] });
  const directory = resolve(process.env.STOCK_BAR_CHECK_OUTPUT || 'artifacts/layout-fixture');
  const profile = resolve(directory, 'profile');
  const watchlist = Array.from({ length: 10 }, (_, index) => ({ symbol: `HK.${String(index + 1).padStart(5, '0')}`,
    name: `行情测试证券 ${index + 1}${index === 0 ? '（超长名称显示检查）' : ''}`, securityType: 3 }));
  await mkdir(profile, { recursive: true });
  await writeFile(resolve(profile, 'stock-bar-settings.json'), JSON.stringify({ version: 4, shortcutDefaultsVersion: 1, preferences: {
    ...DEFAULT_PREFERENCES, connectionMode: 'opend', port: gateway.port, watchlist,
    allView: watchlist.map(item => ({ symbol: item.symbol, showInBar: true })),
    groups: [{ id: 'old-group', name: '旧分组', members: [{ symbol: watchlist[0].symbol, showInBar: false }] }], activeViewId: 'old-group',
  } }));
  const control = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/push') gateway.pushQuotes((url.searchParams.get('symbols')?.split(',') || watchlist.map(item => item.symbol))
      .map(symbol => ({ market: symbol.startsWith('US.') ? 11 : 1, code: symbol.slice(3) })), Number(url.searchParams.get('price')));
    else if (url.pathname === '/drop') { gateway.setAccepting(false); gateway.dropConnections(); }
    else if (url.pathname === '/restore') gateway.setAccepting(true);
    else response.statusCode = 404;
    response.end('{}');
  });
  await new Promise<void>(done => control.listen(0, '127.0.0.1', done));
  const executable = process.env.STOCK_BAR_CHECK_EXECUTABLE;
  const child = spawn(executable || resolve('node_modules/electron/dist/electron.exe'), executable ? ['--layout-check'] : ['.', '--layout-check'], {
    cwd: resolve('.'), windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, STOCK_BAR_TEST_PROFILE: profile,
      STOCK_BAR_CHECK_OUTPUT: directory, STOCK_BAR_FIXTURE_CONTROL: `http://127.0.0.1:${(control.address() as AddressInfo).port}` }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const timer = setTimeout(() => child.kill(), 75000);
  try {
    const code = await new Promise<number | null>((done, reject) => { child.once('exit', done); child.once('error', reject); });
    expect(code, output).toBe(0);
    const report = JSON.parse(await readFile(resolve(directory, 'result.json'), 'utf8'));
    expect(report.passed).toBe(true);
    if (executable) expect(report.executable.toLowerCase()).toBe(resolve(executable).toLowerCase());
    expect(report.checks.length).toBeGreaterThanOrEqual(20);
  } finally {
    clearTimeout(timer); child.kill();
    await new Promise<void>(done => control.close(() => done()));
    await gateway.close();
  }
}, 90000);
