import { BrowserWindow, app } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DEFAULT_SHORTCUTS, nativeBindings, type ShortcutBindings } from '../shared/shortcuts';
import { NativeShortcuts, ShortcutManager } from './shortcuts';
import type { WatchlistPanel } from './watchlist-panel';
import type { BarVisibility } from './visibility';
import type { SettingsStore } from './settings';

const pause = (ms = 180) => new Promise(done => setTimeout(done, ms));
export async function runShortcutCheck(bar: BrowserWindow, getSettings: () => BrowserWindow, panel: WatchlistPanel,
  visibility: BarVisibility, manager: ShortcutManager, store: SettingsStore) {
  const directory = resolve(process.env.STOCK_BAR_CHECK_OUTPUT || 'artifacts/shortcuts'); await mkdir(directory, { recursive: true });
  const checks: string[] = [];
  const assert = (value: unknown, message: string) => { if (!value) throw Error(message); checks.push(message); };
  const wait = async (predicate: () => Promise<boolean> | boolean) => { for (let i = 0; i < 80; i++) { if (await predicate()) return; await pause(75); } throw Error('Timed out waiting for shortcut state'); };
  await wait(() => !!getSettings() && !getSettings().webContents.isLoading() && bar.isVisible());
  const settings = getSettings();
  const evaluate = <T = unknown>(code: string): Promise<T> => settings.webContents.executeJavaScript(code);
  const page = () => bar.webContents.executeJavaScript(`document.querySelector('.page-number').textContent`) as Promise<string>;
  // The 0.9.1 defaults were probed on this desktop; exercise these actual keys.
  let testBindings: ShortcutBindings = { ...DEFAULT_SHORTCUTS };
  let testModifiers = 3;
  const send = async (key: number, duration = 0, presses = 1, modifiers = 3) => {
    if (modifiers === 3 && [72, 87, 37, 39].includes(key)) key = ({ 72: 72, 87: 81, 37: 74, 39: 75 } as Record<number, number>)[key];
    if (modifiers === 3) modifiers = testModifiers;
    await promisify(execFile)(join(directory, 'shortcut-fixture.exe'), [String(modifiers), String(key), String(duration), String(presses)], { windowsHide: true }); await pause();
  };
  const editor = new BrowserWindow({ width: 350, height: 160, title: 'Shortcut validation editor', show: false, webPreferences: { sandbox: true } });
  const blocker = new NativeShortcuts(join(__dirname, '../native/shortcut-monitor.exe'), () => {}, () => {});
  let startup: ShortcutManager | undefined;
  const statePath = join(app.getPath('userData'), 'stock-bar-settings.json');
  try {
    await editor.loadURL('data:text/html,<input autofocus placeholder="Focus validation" />'); editor.show(); editor.focus(); await pause(250);
    const defaultStatuses = manager.snapshot();
    assert(Object.values(defaultStatuses).every(value => value.active || value.message?.includes('Windows')), 'default combinations either register or report explicit Windows conflicts');
    assert(JSON.stringify(store.preferences.shortcuts) === JSON.stringify(DEFAULT_SHORTCUTS), 'saved 0.9.0 defaults upgrade to current defaults before registration');
    if (Object.values(defaultStatuses).some(status => !status.active)) {
      // Keep the user's occupied defaults alone; only this isolated test profile uses the fallback.
      testBindings = { toggleBar: 'Ctrl+Alt+Shift+H', togglePanel: 'Ctrl+Alt+Shift+Q', previousPage: 'Ctrl+Alt+Shift+J', nextPage: 'Ctrl+Alt+Shift+K' };
      testModifiers = 7;
      await manager.save(testBindings, bindings => store.setShortcuts(bindings));
    }
    assert(Object.values(manager.snapshot()).every(status => status.active), 'isolated test combinations register without changing occupied external defaults');
    await send(81); await wait(() => panel.isPresented());
    assert(editor.isFocused(), 'test panel shortcut opens without taking focus'); await send(81);
    assert(editor.isFocused(), 'test panel close preserves editor focus');
    await send(75); assert(await page() === '2/4', 'test next-page shortcut advances');
    await send(74); assert(await page() === '1/4', 'test previous-page shortcut returns');
    await manager.save(testBindings, bindings => store.setShortcuts(bindings));
    assert(Object.values(manager.snapshot()).every(value => value.active), 'current default combinations register together');
    let hidden = 0; const onHide = () => { hidden++; }; bar.on('hide', onHide);
    await send(72, 1000); assert(!bar.isVisible() && hidden === 1, 'long hold hides exactly once');
    await send(72); assert(bar.isVisible(), 'second press restores bar');
    assert(editor.isFocused(), 'bar restore preserves editor focus');
    await send(87, 1000); await wait(() => panel.isPresented());
    assert(panel.isOpen() && editor.isFocused(), 'long hold opens panel once without taking focus');
    await send(27, 0, 1, 0); assert(panel.isOpen(), 'Escape in editor does not dismiss panel');
    await send(87); assert(!panel.isOpen(), 'same panel combination closes panel');
    assert(await page() === '1/4', 'initial page is one of four');
    await send(37); assert(await page() === '4/4', 'previous page wraps from first to last');
    await send(39); assert(await page() === '1/4', 'next page wraps from last to first');
    await send(39, 1000); assert(await page() === '2/4', 'long hold advances one page');
    await send(39, 0, 2); assert(await page() === '4/4', 'repress primary with modifiers held advances twice');
    const originalList = store.preferences.watchlist;
    const smallList = originalList.map((item, index) => ({ ...item, showInBar: index < 2 }));
    await evaluate(`window.stockBar.setWatchlist(${JSON.stringify(smallList)})`); await pause();
    await send(39); await send(37); assert(await page() === '1/1', 'one-page watchlist ignores both page shortcuts');
    await evaluate(`window.stockBar.setWatchlist(${JSON.stringify(originalList)})`); await pause();
    await send(72); const before = await page(); await send(39);
    assert(!bar.isVisible() && await page() === before, 'paging does nothing while manually hidden');
    await send(87); await wait(() => panel.isPresented()); assert(bar.isVisible(), 'panel shortcut restores manually hidden bar');
    await send(72); assert(!bar.isVisible() && !panel.isOpen(), 'hiding bar also closes panel'); await send(72);
    visibility.setSample({ monitor: '1', fullscreenMonitors: ['1'] });
    const intent = visibility.snapshot().manualHidden; const fullPage = await page();
    for (const key of [72, 87, 37, 39]) await send(key);
    assert(!bar.isVisible() && !panel.isOpen() && visibility.snapshot().manualHidden === intent && await page() === fullPage, 'fullscreen blocks all four actions without changing intent or page');
    visibility.setSample({ monitor: '1', fullscreenMonitors: [] }); assert(bar.isVisible(), 'exiting fullscreen restores original display intent');
    visibility.hide(); visibility.setSample({ monitor: '1', fullscreenMonitors: ['1'] }); await send(72);
    visibility.setSample({ monitor: '1', fullscreenMonitors: [] }); assert(!bar.isVisible(), 'manual hiding survives fullscreen shortcut'); visibility.restore();

    settings.show(); settings.focus(); await pause(200);
    const record = async (action: string) => { await evaluate(`document.getElementById('shortcut-${action}').focus(); document.getElementById('shortcut-${action}').click()`); await pause(200); };
    await record('togglePanel'); await send(72, 1000);
    assert(bar.isVisible() && !panel.isOpen(), 'recording an existing combination does not execute it');
    assert(await evaluate(`document.getElementById('shortcut-togglePanel').value`) === testBindings.toggleBar, 'existing registered combination is captured');
    await record('togglePanel'); await send(123);
    assert(await evaluate(`document.querySelector('.shortcut-settings').textContent.includes('F12 由 Windows 保留')`), 'F12 capture reports reserved key');
    await send(27, 0, 1, 0); await pause();
    assert(!await evaluate(`!!document.querySelector('.shortcut-settings .recording')`), 'Escape cancels recording');
    await record('togglePanel'); editor.focus(); await pause(250); await send(72);
    assert(!bar.isVisible(), 'leaving settings cancels recording and restores original binding'); await send(72);

    await blocker.start();
    const blocked: ShortcutBindings = { toggleBar: 'Ctrl+Alt+Shift+F10', togglePanel: null, previousPage: null, nextPage: null };
    const blocking = await blocker.request('sync', { bindings: nativeBindings(blocked) });
    assert(blocking.statuses?.[0]?.active, 'separate process owns conflict combination');
    settings.focus(); await pause(200); await record('toggleBar'); await send(121, 0, 1, 7);
    assert(await evaluate(`document.getElementById('shortcut-toggleBar').value`) === blocked.toggleBar, 'recording captures an externally occupied combination');
    await evaluate(`Array.from(document.querySelectorAll('.shortcut-settings button')).find(button => button.textContent === '保存快捷键').click()`); await pause(250);
    assert(store.preferences.shortcuts.toggleBar === testBindings.toggleBar, 'conflicted UI save preserves original config');
    assert(await evaluate(`document.querySelector('.shortcut-settings').textContent.includes('被占用')`), 'UI displays conflict failure');
    await evaluate(`Array.from(document.querySelectorAll('.shortcut-settings button')).find(button => button.textContent === '取消修改').click()`);
    await evaluate(`document.querySelector('.shortcut-row button').click()`);
    assert(store.preferences.shortcuts.toggleBar === testBindings.toggleBar, 'disable remains a draft before save');
    await evaluate(`Array.from(document.querySelectorAll('.shortcut-settings button')).find(button => button.textContent === '保存快捷键').click()`); await pause(250);
    assert(store.preferences.shortcuts.toggleBar === null && !manager.snapshot().toggleBar.active, 'UI save disables and releases selected binding');
    editor.focus(); await pause(); await send(72); assert(bar.isVisible(), 'disabled binding no longer changes bar visibility');
    assert((await evaluate<{ ok: boolean }>(`window.stockBar.saveShortcuts(${JSON.stringify(testBindings)})`)).ok, 'disabled action can be enabled again');
    const swapped = { ...testBindings, toggleBar: testBindings.togglePanel, togglePanel: testBindings.toggleBar };
    const save = (bindings: ShortcutBindings) => evaluate<{ ok: boolean; message?: string }>(`window.stockBar.saveShortcuts(${JSON.stringify(bindings)})`);
    assert((await save(swapped)).ok, 'swapping two owned combinations saves as one group');
    assert(JSON.parse(await readFile(statePath, 'utf8')).preferences.shortcuts.toggleBar === swapped.toggleBar, 'new bindings persist on disk');
    editor.focus(); await pause(100); await send(87); assert(!bar.isVisible(), 'swapped binding executes new action'); await send(87);
    await mkdir(statePath + '.tmp');
    try { assert(!(await save(testBindings)).ok, 'disk write failure rejects entire save'); }
    finally { await rmdir(statePath + '.tmp'); }
    assert(store.preferences.shortcuts.toggleBar === swapped.toggleBar, 'failed disk write preserves in-memory config');
    await send(87); assert(!bar.isVisible(), 'failed disk write preserves native mapping'); await send(87);
    assert((await save(testBindings)).ok, 'successful save works after disk failure');
    await evaluate(`Array.from(document.querySelectorAll('.shortcut-settings button')).find(button => button.textContent === '取消修改').click(); document.querySelector('.shortcut-settings').scrollIntoView({block:'start'})`);
    await pause(200);
    await writeFile(join(directory, 'settings.png'), (await settings.webContents.capturePage()).toPNG());

    manager.stop(); await pause(300);
    const startupBindings = { ...testBindings, toggleBar: blocked.toggleBar };
    startup = new ShortcutManager(startupBindings, (event, unavailable) => new NativeShortcuts(join(__dirname, '../native/shortcut-monitor.exe'), event, unavailable), () => {}, () => {}, () => {});
    await startup.retry();
    assert(!startup.snapshot().toggleBar.active && startup.snapshot().togglePanel.active, 'startup conflict affects only the occupied item');
    // A failed edit must preserve which keys were actually held, including an old
    // configured key that was unavailable at startup but becomes free mid-edit.
    const newConflict = { ...blocked, toggleBar: 'Ctrl+Alt+Shift+F5' };
    await blocker.request('sync', { bindings: nativeBindings(newConflict) });
    let rejected = false;
    try { await startup.save({ ...startupBindings, togglePanel: newConflict.toggleBar }, async () => { throw Error('must not persist rejected group'); }); }
    catch { rejected = true; }
    assert(rejected, 'failed group edit is rejected after a previously unavailable key becomes free');
    const probe = new NativeShortcuts(join(__dirname, '../native/shortcut-monitor.exe'), () => {}, () => {});
    try {
      await probe.start(); const releasedKey = await probe.request('sync', { bindings: nativeBindings(blocked) });
      assert(releasedKey.statuses?.[0]?.active, 'rollback releases newly acquired old-config key instead of silently reserving it');
    } finally { probe.stop(); }
    await pause(250);
    blocker.stop(); await pause(300); await startup.retry();
    assert(Object.values(startup.snapshot()).every(status => status.active), 'explicit retry registers released combination');
    startup.stop(); await pause(300);
    const released = await blocker.start().then(() => blocker.request('sync', { bindings: nativeBindings(startupBindings) }));
    assert(released.statuses?.every(status => status.active), 'stopping helper releases all combinations');
    bar.removeListener('hide', onHide);
    await writeFile(join(directory, 'result.json'), JSON.stringify({ passed: true, defaultStatuses, testBindings, checks }, null, 2));
    console.log(JSON.stringify({ passed: true, checks: checks.length }));
  } catch (error) {
    await writeFile(join(directory, 'result.json'), JSON.stringify({ passed: false, checks, error: String(error), focusedWindow: BrowserWindow.getFocusedWindow()?.getTitle() }, null, 2)); throw error;
  } finally { startup?.stop(); blocker.stop(); editor.destroy(); }
}
