import { app, screen, type BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BarVisibility } from './visibility';
import type { StockState } from '../shared/stock';

export async function runFullscreenCheck(bar: BrowserWindow, visibility: BarVisibility, health: () => string, quotes?: () => StockState) {
  const directory = resolve(process.env.STOCK_BAR_CHECK_OUTPUT || 'artifacts'); await mkdir(directory, { recursive: true });
  const observations: object[] = [];
  const assert = async (name: string, predicate: () => boolean) => {
    const end = Date.now() + 6000;
    while (!predicate() && Date.now() < end) await new Promise(done => setTimeout(done, 100));
    const passed = predicate(); observations.push({ name, passed, windowVisible: bar.isVisible(), ...visibility.snapshot(), health: health() });
    if (!passed) throw new Error('Fullscreen check failed: ' + name);
  };
  const fixtureDirectory = join(directory, 'fixture-' + randomUUID()); await mkdir(fixtureDirectory);
  const child = spawn(process.execPath, [...(app.isPackaged ? [] : [app.getAppPath()]), '--fullscreen-fixture'], {
    windowsHide: false, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, STOCK_BAR_FIXTURE_PROFILE: fixtureDirectory },
  });
  let sequence = 0; let spawnError: Error | undefined;
  let fixtureError = '';
  child.stderr!.on('data', data => { fixtureError = (fixtureError + String(data)).slice(-3000); });
  child.once('error', error => { spawnError = error; });
  const command = async (command: string) => {
    const next = ++sequence;
    await writeFile(join(fixtureDirectory, 'command.json'), JSON.stringify({ sequence: next, command }));
    const end = Date.now() + 6000;
    while (!spawnError && Date.now() < end) {
      try { if (JSON.parse(await readFile(join(fixtureDirectory, 'reply.json'), 'utf8')).sequence === next) return; } catch {}
      await new Promise(done => setTimeout(done, 50));
    }
    throw spawnError || new Error('Test fixture did not reply: ' + fixtureError);
  };
  let passed = false;
  try {
    await assert('native detector started', () => health() === 'active');
    await command('display:0');
    const primary = screen.getAllDisplays()[0].workArea;
    bar.setPosition(primary.x + 20, primary.y + 20);
    visibility.restore();
    await assert('ordinary window stays visible', () => bar.isVisible());
    await command('maximize');
    // Wait at least two native polling intervals before checking a negative condition.
    await new Promise(done => setTimeout(done, 1000));
    await assert('maximized window is not fullscreen', () => bar.isVisible() && !visibility.snapshot().fullscreen);
    await command('fullscreen');
    await assert('same-monitor fullscreen hides bar', () => !bar.isVisible() && visibility.snapshot().fullscreen);
    if (quotes) {
      await assert('packaged app restores OpenD connection and watchlist', () => quotes().connection === 'connected' && quotes().rows.some(row => row.quote));
      const before = quotes().rows.map(row => ({ symbol: row.symbol, pushCount: row.pushCount }));
      const end = Date.now() + 5000;
      while (Date.now() < end && !quotes().rows.some(row => row.pushCount > (before.find(item => item.symbol === row.symbol)?.pushCount || 0)))
        await new Promise(done => setTimeout(done, 200));
      const after = quotes().rows.map(row => ({ symbol: row.symbol, pushCount: row.pushCount, price: row.quote?.price }));
      const updated = after.some(row => row.pushCount > (before.find(item => item.symbol === row.symbol)?.pushCount || 0));
      observations.push({ name: 'real quotes continue while fullscreen-hidden', passed: updated, before, after, hidden: !bar.isVisible() });
      if (!updated) throw new Error('No live updates observed while hidden; recheck during an active market.');
    }
    await command('normal');
    await assert('exit fullscreen restores without focus', () => bar.isVisible() && !bar.isFocused() && !bar.isFocusable());
    await command('video');
    await assert('HTML video fullscreen hides bar', () => !bar.isVisible() && visibility.snapshot().fullscreen);
    await command('normal');
    await assert('exit video fullscreen restores', () => bar.isVisible() && !visibility.snapshot().fullscreen);
    visibility.hide(); await command('fullscreen');
    await assert('manual hidden during fullscreen', () => !bar.isVisible() && visibility.snapshot().fullscreen);
    await command('normal');
    await new Promise(done => setTimeout(done, 1000));
    await assert('exit fullscreen preserves manual hide', () => !bar.isVisible() && !visibility.snapshot().fullscreen && visibility.snapshot().manualHidden);
    visibility.restore(); await assert('explicit restore shows bar', () => bar.isVisible());
    await command('fullscreen');
    await assert('second fullscreen hides', () => !bar.isVisible());
    visibility.hide(); visibility.restore();
    await assert('restore during fullscreen waits', () => !bar.isVisible() && visibility.snapshot().fullscreen);
    if (screen.getAllDisplays().length > 1) {
      const second = screen.getAllDisplays()[1].workArea;
      bar.setPosition(second.x + 20, second.y + 20);
      await assert('other-monitor fullscreen does not hide', () => bar.isVisible() && !visibility.snapshot().fullscreen);
      bar.setPosition(primary.x + 20, primary.y + 20);
      await assert('move back onto fullscreen monitor hides', () => !bar.isVisible() && visibility.snapshot().fullscreen);
    } else observations.push({ name: 'other-monitor fullscreen', passed: null, reason: 'Only one physical display available; monitor routing covered by unit tests.' });
    await command('normal');
    await assert('final restoration', () => bar.isVisible() && !visibility.snapshot().fullscreen);
    passed = true;
  } finally {
    if (!child.killed) child.kill();
    const result = { passed, capturedAt: new Date().toISOString(), packaged: app.isPackaged,
      runtime: process.versions.electron, liveState: quotes?.(), displays: screen.getAllDisplays().map(display => ({ bounds: display.bounds, scaleFactor: display.scaleFactor })), observations };
    await writeFile(join(directory, 'fullscreen-check.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  }
}
