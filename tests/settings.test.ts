import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { SettingsStore } from '../src/main/settings';
import { DEFAULT_PREFERENCES } from '../src/shared/stock';
import { DEFAULT_SHORTCUTS } from '../src/shared/shortcuts';

it('upgrades saved 0.9.0 defaults once and keeps a later explicit rebind to an old combination', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stock-bar-test-'));
  const path = join(directory, 'settings.json');
  const cipher = { available: () => true, encrypt: (text: string) => Buffer.from(text), decrypt: (data: Buffer) => data.toString() };
  try {
    const old = { toggleBar: 'Ctrl+Alt+H', togglePanel: 'Ctrl+Alt+W', previousPage: 'Ctrl+Alt+Left', nextPage: 'Ctrl+Alt+Right' };
    const watchlist = [{ symbol: 'HK.00700', name: '腾讯', securityType: 3, showInBar: true }];
    await writeFile(path, JSON.stringify({ version: 3, preferences: { ...DEFAULT_PREFERENCES, shortcuts: old, watchlist, position: { x: 50, y: 60 } }, encryptedKey: Buffer.from('fixture-only-key').toString('base64') }));
    const store = new SettingsStore(path, cipher); await store.load();
    expect(store.warning).toBe(''); expect(store.preferences.shortcuts).toEqual(DEFAULT_SHORTCUTS);
    expect(store.preferences.watchlist).toEqual(watchlist); expect(store.preferences.position).toEqual({ x: 50, y: 60 });
    expect(store.key).toBe('fixture-only-key');
    expect(JSON.parse(await readFile(path, 'utf8')).shortcutDefaultsVersion).toBe(1);
    await store.setShortcuts({ ...DEFAULT_SHORTCUTS, togglePanel: old.togglePanel });
    const reloaded = new SettingsStore(path, cipher); await reloaded.load();
    expect(reloaded.preferences.shortcuts.togglePanel).toBe(old.togglePanel);
  } finally {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('stock-bar-test-')) throw Error('Unsafe cleanup');
    await rm(directory, { recursive: true });
  }
});

it('preserves custom and disabled bindings and avoids new duplicates during the defaults upgrade', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stock-bar-test-'));
  const path = join(directory, 'settings.json');
  const cipher = { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' };
  try {
    const shortcuts = { toggleBar: DEFAULT_SHORTCUTS.togglePanel, togglePanel: 'Ctrl+Alt+W', previousPage: null, nextPage: 'Ctrl+Alt+Right' };
    await writeFile(path, JSON.stringify({ version: 3, preferences: { ...DEFAULT_PREFERENCES, shortcuts } }));
    const original = await readFile(path, 'utf8');
    const diagnostic = new SettingsStore(path, cipher); await diagnostic.load(false);
    expect(await readFile(path, 'utf8')).toBe(original);
    const store = new SettingsStore(path, cipher); await store.load();
    expect(store.preferences.shortcuts).toEqual({ ...shortcuts, nextPage: DEFAULT_SHORTCUTS.nextPage, nextMarket: DEFAULT_SHORTCUTS.nextMarket });
    expect(store.warning).toBe('');
    const reloaded = new SettingsStore(path, cipher); await reloaded.load();
    expect(reloaded.preferences.shortcuts).toEqual(store.preferences.shortcuts);
  } finally {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('stock-bar-test-')) throw Error('Unsafe cleanup');
    await rm(directory, { recursive: true });
  }
});

it('persists only preferences and a protected secret, and safely reloads without quote cache', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stock-bar-test-'));
  const path = join(directory, 'settings.json');
  // Test-only reversible cipher exercises persistence flow; production uses Electron safeStorage/Windows DPAPI.
  const cipher = { available: () => true, encrypt: (text: string) => Buffer.from(text.split('').reverse().join('')), decrypt: (data: Buffer) => data.toString().split('').reverse().join('') };
  try {
    const store = new SettingsStore(path, cipher); await store.load();
    expect(store.preferences.watchlist).toEqual([]);
    await store.setConnection({ host: '127.0.0.1', port: 33333, ssl: false, key: 'test-only-secret', rememberKey: true });
    const data = await readFile(path, 'utf8'); expect(data).not.toContain('test-only-secret'); expect(data).not.toContain('quote');
    const loaded = new SettingsStore(path, cipher); await loaded.load(); expect(loaded.key).toBe('test-only-secret'); expect(loaded.keySaved).toBe(true);
    await loaded.setConnection({ host: '127.0.0.1', port: 33333, ssl: false, rememberKey: false });
    expect(JSON.parse(await readFile(path, 'utf8')).encryptedKey).toBeUndefined();
    expect(loaded.key).toBe('test-only-secret');
  } finally {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('stock-bar-test-')) throw new Error('Unsafe test cleanup path');
    await rm(target, { recursive: true });
  }
});

it('adds default shortcuts to old settings and persists custom and disabled bindings without changing the watchlist', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stock-bar-test-'));
  const path = join(directory, 'settings.json');
  const cipher = { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' };
  try {
    const { shortcuts: _shortcuts, ...old } = DEFAULT_PREFERENCES;
    const watchlist = [{ symbol: 'US.AAPL', name: 'Apple', securityType: 3, showInBar: true }];
    await writeFile(path, JSON.stringify({ version: 3, preferences: { ...old, watchlist, position: { x: 20, y: 30 } } }));
    const store = new SettingsStore(path, cipher); await store.load();
    expect(store.preferences.shortcuts).toEqual(DEFAULT_SHORTCUTS);
    await store.setShortcuts({ ...DEFAULT_SHORTCUTS, toggleBar: 'Ctrl+Shift+H', nextPage: null });
    const restored = new SettingsStore(path, cipher); await restored.load();
    expect(restored.preferences.shortcuts).toEqual({ ...DEFAULT_SHORTCUTS, toggleBar: 'Ctrl+Shift+H', nextPage: null });
    expect(restored.preferences.watchlist).toEqual(watchlist); expect(restored.preferences.position).toEqual({ x: 20, y: 30 });
  } finally {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('stock-bar-test-')) throw Error('Unsafe cleanup');
    await rm(directory, { recursive: true });
  }
});

it('keeps newer shortcuts when another settings write is queued behind a shortcut commit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stock-bar-test-'));
  const path = join(directory, 'settings.json');
  const cipher = { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' };
  try {
    const store = new SettingsStore(path, cipher);
    const changed = { ...DEFAULT_SHORTCUTS, togglePanel: null };
    const shortcutWrite = store.setShortcuts(changed);
    store.preferences = { ...store.preferences, fontSize: 18 };
    const appearanceWrite = store.save();
    await Promise.all([shortcutWrite, appearanceWrite]);
    const loaded = new SettingsStore(path, cipher); await loaded.load();
    expect(loaded.preferences.shortcuts).toEqual(changed); expect(loaded.preferences.fontSize).toBe(18);
  } finally {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('stock-bar-test-')) throw Error('Unsafe cleanup');
    await rm(directory, { recursive: true });
  }
});

it('migrates the old whole-window width without losing watchlist, position, appearance or the protected key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stock-bar-test-'));
  const path = join(directory, 'settings.json');
  const cipher = { available: () => true, encrypt: (text: string) => Buffer.from(text), decrypt: (data: Buffer) => data.toString() };
  const { securityWidth: _unused, ...preferences } = DEFAULT_PREFERENCES;
  const watchlist = [{ symbol: 'HK.00700', name: '腾讯控股', securityType: 3 }];
  try {
    await writeFile(path, JSON.stringify({ version: 1, encryptedKey: Buffer.from('test-only-key').toString('base64'),
      preferences: { ...preferences, width: 1200, fontSize: 20, opacity: 0.6, autoStart: true, port: 34567, watchlist, position: { x: 100, y: 200 } } }));
    const store = new SettingsStore(path, cipher); await store.load();
    expect(store.warning).toBe('');
    expect(store.preferences).toMatchObject({ securityWidth: 180, fontSize: 20, opacity: 0.6, autoStart: true, port: 34567, watchlist, position: { x: 100, y: 200 } });
    expect(store.key).toBe('test-only-key'); expect(store.keySaved).toBe(true);
    const migrated = JSON.parse(await readFile(path, 'utf8'));
    expect(migrated.version).toBe(5); expect(migrated.preferences.width).toBeUndefined();
    store.preferences.securityWidth = 240; await store.save();
    const reloaded = new SettingsStore(path, cipher); await reloaded.load();
    expect(reloaded.preferences.securityWidth).toBe(240); expect(reloaded.key).toBe('test-only-key');
  } finally {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('stock-bar-test-')) throw new Error('Unsafe test cleanup path');
    await rm(target, { recursive: true });
  }
});

it('reads legacy protected settings for diagnostics without migrating or rewriting the user file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stock-bar-test-'));
  const path = join(directory, 'settings.json');
  const cipher = { available: () => true, encrypt: (text: string) => Buffer.from(text), decrypt: (data: Buffer) => data.toString() };
  const { securityWidth: _unused, ...preferences } = DEFAULT_PREFERENCES;
  const original = JSON.stringify({ version: 1, preferences: { ...preferences, width: 900 }, encryptedKey: Buffer.from('fixture-key').toString('base64') });
  try {
    await writeFile(path, original);
    const store = new SettingsStore(path, cipher); await store.load(false);
    expect(store.key).toBe('fixture-key'); expect(store.preferences.securityWidth).toBe(180);
    expect(await readFile(path, 'utf8')).toBe(original);
  } finally {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('stock-bar-test-')) throw new Error('Unsafe test cleanup path');
    await rm(target, { recursive: true });
  }
});

it('migrates legacy selections and reloads large watchlists including an explicitly empty bar', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stock-bar-test-'));
  const path = join(directory, 'settings.json');
  const cipher = { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' };
  const watchlist = Array.from({ length: 24 }, (_, index) => ({ symbol: `HK.${String(index + 1).padStart(5, '0')}`, name: `证券 ${index}`, securityType: 3 }));
  const { barPageSize: _unused, ...legacy } = DEFAULT_PREFERENCES;
  try {
    await writeFile(path, JSON.stringify({ version: 2, preferences: { ...legacy, watchlist } }));
    const store = new SettingsStore(path, cipher); await store.load();
    expect(store.warning).toBe('');
    expect(store.preferences.barPageSize).toBe(3);
    expect(store.preferences.watchlist).toHaveLength(24);
    expect(store.preferences.watchlist.every(item => item.showInBar === true)).toBe(true);
    expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(5);
    store.preferences.watchlist = store.preferences.watchlist.map(item => ({ ...item, showInBar: false }));
    store.preferences.barPageSize = 20; await store.save();
    const restored = new SettingsStore(path, cipher); await restored.load();
    expect(restored.warning).toBe('');
    expect(restored.preferences.barPageSize).toBe(20);
    expect(restored.preferences.watchlist).toHaveLength(24);
    expect(restored.preferences.watchlist.every(item => item.showInBar === false)).toBe(true);
  } finally {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('stock-bar-test-')) throw new Error('Unsafe test cleanup path');
    await rm(target, { recursive: true });
  }
});
