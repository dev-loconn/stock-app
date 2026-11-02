import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { DEFAULT_PREFERENCES } from '../src/shared/stock';

it.skipIf(process.env.STOCK_BAR_SHORTCUT_CHECK !== '1')('validates native shortcuts, capture, focus, fullscreen and rollback', async () => {
  const output = resolve('artifacts/shortcuts'); const profile = resolve(output, 'profile'); await mkdir(profile, { recursive: true });
  const legacy = { ...DEFAULT_PREFERENCES, shortcuts: { toggleBar: 'Ctrl+Alt+H', togglePanel: 'Ctrl+Alt+W', previousPage: 'Ctrl+Alt+Left', nextPage: 'Ctrl+Alt+Right' } };
  const watchlist = Array.from({ length: 10 }, (_, index) => ({ symbol: `HK.${String(index + 1).padStart(5, '0')}`, name: `验证证券${index + 1}`, securityType: 3, showInBar: true }));
  await writeFile(resolve(profile, 'stock-bar-settings.json'), JSON.stringify({ version: 3, preferences: { ...legacy, watchlist } }));
  const executable = process.env.STOCK_BAR_CHECK_EXECUTABLE;
  const child = spawn(executable || resolve('node_modules/electron/dist/electron.exe'), executable ? ['--shortcuts-check'] : ['.', '--shortcuts-check'], {
    cwd: resolve('.'), windowsHide: false, env: { ...process.env, STOCK_BAR_TEST_PROFILE: profile, STOCK_BAR_CHECK_OUTPUT: output }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let outputText = ''; child.stdout.on('data', data => { outputText += data; }); child.stderr.on('data', data => { outputText += data; });
  const timer = setTimeout(() => child.kill(), 90000);
  try {
    const code = await new Promise<number | null>((done, reject) => { child.once('exit', done); child.once('error', reject); });
    expect(code, outputText).toBe(0);
    const report = JSON.parse(await readFile(resolve(output, 'result.json'), 'utf8'));
    expect(report.passed).toBe(true); expect(report.checks.length).toBeGreaterThan(30);
  } finally { clearTimeout(timer); child.kill(); }
}, 100000);
