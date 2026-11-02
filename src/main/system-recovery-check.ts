import { app, BrowserWindow, net, powerMonitor } from 'electron';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { QuoteProvider as QuoteService } from './market-service';
import { formatPrice, type Preferences } from '../shared/stock';

/** Records actual OS operations driven by the separate, explicitly elevated acceptance script. */
export async function runSystemRecoveryCheck(bar: BrowserWindow, service: QuoteService, preferences: Preferences, key: string) {
  const directory = resolve(process.env.STOCK_BAR_SYSTEM_OUTPUT || 'artifacts/system-recovery');
  await mkdir(directory, { recursive: true });
  const startedAt = new Date().toISOString();
  const events: { event: string; at: string }[] = [];
  const onSuspend = () => { events.push({ event: 'suspend', at: new Date().toISOString() }); };
  const onResume = () => { events.push({ event: 'resume', at: new Date().toISOString() }); };
  powerMonitor.on('suspend', onSuspend); powerMonitor.on('resume', onResume);
  const transitions: unknown[] = [];
  let previous = '';
  let finished = false;
  let sequence = 0;
  let phase: Record<string, unknown> = {};
  service.configure(preferences, key);
  try {
    while (!finished && Date.now() - Date.parse(startedAt) < 20 * 60000) {
      try { phase = JSON.parse((await readFile(join(directory, 'phase.json'), 'utf8')).replace(/^\uFEFF/, '')); } catch { /* The OS runner starts after this monitor. */ }
      const state = service.state(false);
      const dom = await bar.webContents.executeJavaScript(`({connection:document.querySelector('.connection-word')?.textContent, prices:Array.from(document.querySelectorAll('.quote-line strong')).map(n=>n.textContent)})`);
      const value = { sequence: ++sequence, at: new Date().toISOString(), phase, connection: state.connection, message: state.message,
        retryAt: state.retryAt, online: net.isOnline(), diagnostics: service.diagnostics(), events: [...events], dom,
        rows: state.rows.map(row => ({ symbol: row.symbol, price: row.quote?.price, displayedPrice: formatPrice(row.quote),
          sourceEpoch: row.quote?.sourceEpoch, receivedAt: row.quote?.receivedAt, pushCount: row.pushCount,
          permission: row.permission, status: row.status, marketState: row.marketState })) };
      await appendFile(join(directory, 'states.jsonl'), JSON.stringify(value) + '\n');
      await writeFile(join(directory, 'current.json.tmp'), JSON.stringify(value, null, 2) + '\n');
      await rename(join(directory, 'current.json.tmp'), join(directory, 'current.json'));
      const signature = JSON.stringify({ phase, connection: value.connection, online: value.online, subscriptions: value.diagnostics.basicSubscriptions, events: events.length });
      if (signature !== previous) {
        transitions.push(value); previous = signature;
        await writeFile(join(directory, `frame-${sequence}.png`), (await bar.webContents.capturePage()).toPNG());
      }
      if (phase.stage === 'complete') finished = true;
      else await new Promise(done => setTimeout(done, 500));
    }
    await writeFile(join(directory, 'monitor-result.json'), JSON.stringify({ completed: finished, startedAt,
      finishedAt: new Date().toISOString(), appVersion: app.getVersion(), electron: process.versions.electron,
      sdk: require('futu-api/package.json').version, nativePowerEvents: events, transitions }, null, 2) + '\n');
  } finally {
    powerMonitor.removeListener('suspend', onSuspend); powerMonitor.removeListener('resume', onResume); service.stop();
  }
  if (!finished) throw Error('真实系统验收监视器等待超时');
}
