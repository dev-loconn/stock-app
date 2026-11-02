import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { DEFAULT_PREFERENCES } from '../src/shared/stock';
import { createGateway } from './gateway';

it.skipIf(process.env.STOCK_BAR_PANEL_CHECK !== '1')('validates the anchored panel and native window lifecycle', async () => {
  const gateway = await createGateway();
  const directory = resolve(process.env.STOCK_BAR_CHECK_OUTPUT || 'artifacts/panel-fixture');
  const profile = resolve(directory, 'profile');
  const watchlist = Array.from({ length: 10 }, (_, index) => ({ symbol: `HK.${String(index + 1).padStart(5, '0')}`,
    name: ['长和（超长证券名称展示检查）', '中电控股', '香港中华煤气', '九龙仓集团', '汇丰控股', '电能实业', '智富资源投资', '电讯盈科', '金奥国际', '恒隆集团'][index], securityType: 3 }));
  await mkdir(profile, { recursive: true });
  await writeFile(resolve(profile, 'stock-bar-settings.json'), JSON.stringify({ version: 2,
    preferences: { ...DEFAULT_PREFERENCES, connectionMode: 'opend', port: gateway.port, watchlist } }));
  const control = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/push') gateway.pushQuotes(watchlist.map(item => ({ market: 1, code: item.symbol.slice(3) })), Number(url.searchParams.get('price')));
    else if (url.pathname === '/drop') { gateway.setAccepting(false); gateway.dropConnections(); }
    else if (url.pathname === '/restore') gateway.setAccepting(true);
    else if (url.pathname === '/stats') { response.end(JSON.stringify({ connections: gateway.connections(), subscriptions: gateway.calls.filter(call => call.cmd === 3001).length })); return; }
    else response.statusCode = 404;
    response.end('{}');
  });
  await new Promise<void>(done => control.listen(0, '127.0.0.1', done));
  const executable = process.env.STOCK_BAR_CHECK_EXECUTABLE;
  const child = spawn(executable || resolve('node_modules/electron/dist/electron.exe'), executable ? ['--panel-check'] : ['.', '--panel-check'], {
    cwd: resolve('.'), windowsHide: false, env: { ...process.env, STOCK_BAR_TEST_PROFILE: profile,
      STOCK_BAR_CHECK_OUTPUT: directory, STOCK_BAR_FIXTURE_CONTROL: `http://127.0.0.1:${(control.address() as AddressInfo).port}` }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const timer = setTimeout(() => child.kill(), process.env.STOCK_BAR_PANEL_PREVIEW === '1' ? 300000 : 90000);
  try {
    const code = await new Promise<number | null>((done, reject) => { child.once('exit', done); child.once('error', reject); });
    expect(code, output).toBe(0);
    const report = JSON.parse(await readFile(resolve(directory, 'result.json'), 'utf8'));
    expect(report.passed).toBe(true);
    expect(report.checks.length).toBeGreaterThanOrEqual(30);
    if (executable) expect(report.executable.toLowerCase()).toBe(resolve(executable).toLowerCase());
  } finally {
    clearTimeout(timer); child.kill();
    await new Promise<void>(done => control.close(() => done()));
    await gateway.close();
  }
}, 310000);
