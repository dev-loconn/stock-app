import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SettingsStore } from '../src/main/settings';
import { barItems, DEFAULT_PREFERENCES, marketItems, nextWatchMarket } from '../src/shared/stock';

const items = ['US.AAPL', 'HK.00700', 'US.SPY', 'SH.600519'].map((symbol, index) => ({ symbol, name: symbol, securityType: 3, showInBar: index !== 2 }));
it('filters markets in global order while keeping panel-only items and A shares in all', () => {
  expect(marketItems(items, 'US').map(item => item.symbol)).toEqual(['US.AAPL', 'US.SPY']);
  expect(barItems(marketItems(items, 'US')).map(item => item.symbol)).toEqual(['US.AAPL']);
  expect(marketItems(items, 'all')).toEqual(items);
  expect(marketItems([], 'HK')).toEqual([]);
  expect(['all', 'HK', 'US'].map(value => nextWatchMarket(value as 'all' | 'HK' | 'US'))).toEqual(['HK', 'US', 'all']);
});
it('migrates old shortcuts without stealing a custom key, persists market, and rolls back failed writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stock-market-test-'));
  const path = join(directory, 'settings.json');
  const cipher = { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' };
  try {
    const { nextMarket: _key, ...oldShortcuts } = DEFAULT_PREFERENCES.shortcuts;
    const { watchMarket: _market, ...oldPreferences } = DEFAULT_PREFERENCES;
    await writeFile(path, JSON.stringify({ version: 5, shortcutDefaultsVersion: 1, preferences: {
      ...oldPreferences, watchlist: items, shortcuts: { ...oldShortcuts, togglePanel: 'alt+ctrl+m', nextPage: null },
    } }));
    const store = new SettingsStore(path, cipher); await store.load();
    expect(store.warning).toBe(''); expect(store.preferences.watchMarket).toBe('all');
    expect(store.preferences.shortcuts.nextMarket).toBeNull();
    expect(store.preferences.shortcuts.togglePanel).toBe('Ctrl+Alt+M');
    expect(store.preferences.shortcuts.nextPage).toBeNull();
    await Promise.all([store.setWatchMarket(), store.setWatchMarket()]);
    expect(store.preferences.watchMarket).toBe('US');
    const restored = new SettingsStore(path, cipher); await restored.load();
    expect(restored.preferences).toEqual(store.preferences);
    expect(restored.preferences.watchlist).toEqual(items);
    await expect(store.setWatchMarket('CN')).rejects.toThrow('市场');
    const saved = await readFile(path, 'utf8'); await mkdir(path + '.tmp');
    await expect(store.setWatchMarket('HK')).rejects.toThrow();
    expect(store.preferences.watchMarket).toBe('US'); expect(await readFile(path, 'utf8')).toBe(saved);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
