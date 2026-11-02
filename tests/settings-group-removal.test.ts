import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { SettingsStore } from '../src/main/settings';
import { DEFAULT_PREFERENCES } from '../src/shared/stock';

const cipher = { available: () => true, encrypt: (text: string) => Buffer.from(text), decrypt: (data: Buffer) => data.toString() };
const watchlist = [
  { symbol: 'HK.00700', name: '腾讯', aliases: ['Tencent'], securityType: 3 },
  { symbol: 'US.AAPL', name: '苹果', securityType: 3 },
  { symbol: 'US.SPY', name: 'SPY', securityType: 4 },
];
function grouped() {
  return { version: 4, shortcutDefaultsVersion: 1, encryptedKey: Buffer.from('fixture-only').toString('base64'), preferences: {
    ...DEFAULT_PREFERENCES, watchlist, position: { x: 123, y: 234 }, opacity: 0.65, barPageSize: 2,
    shortcuts: { ...DEFAULT_PREFERENCES.shortcuts, togglePanel: null },
    allView: [{ symbol: 'US.SPY', showInBar: false }, { symbol: 'HK.00700', showInBar: true }, { symbol: 'US.AAPL', showInBar: false }],
    groups: [{ id: 'us', name: '美股', members: [{ symbol: 'US.AAPL', showInBar: true }] }], activeViewId: 'us',
  } };
}
async function profile(run: (store: SettingsStore, path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'stock-ungroup-test-'));
  try { const path = join(directory, 'settings.json'); await run(new SettingsStore(path, cipher), path); }
  finally {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('stock-ungroup-test-')) throw Error('Unsafe cleanup');
    await rm(directory, { recursive: true });
  }
}
it('flattens v4 using all-watchlist order and selections, retaining every security and protected setting', () => profile(async (store, path) => {
  const original = JSON.stringify(grouped()); await writeFile(path, original); await store.load();
  expect(store.warning).toBe('');
  expect(store.preferences.watchlist).toEqual([
    { ...watchlist[2], showInBar: false }, { ...watchlist[0], showInBar: true }, { ...watchlist[1], showInBar: false },
  ]);
  expect(store.preferences).toMatchObject({ position: { x: 123, y: 234 }, opacity: 0.65, barPageSize: 2 });
  expect(store.preferences.shortcuts.togglePanel).toBe(null); expect(store.key).toBe('fixture-only');
  expect(await readFile(path + '.v4-backup', 'utf8')).toBe(original);
  const saved = JSON.parse(await readFile(path, 'utf8')); expect(saved.version).toBe(5);
  for (const field of ['groups', 'allView', 'activeViewId']) expect(saved.preferences).not.toHaveProperty(field);
  const restored = new SettingsStore(path, cipher); await restored.load();
  expect(restored.preferences).toEqual(store.preferences); expect(restored.key).toBe(store.key);
}));
it('keeps an explicit empty global display selection even if the former active group had checked members', () => profile(async (store, path) => {
  const data = grouped(); data.preferences.allView = data.preferences.allView.map(item => ({ ...item, showInBar: false }));
  await writeFile(path, JSON.stringify(data)); await store.load();
  expect(store.preferences.watchlist).toHaveLength(3); expect(store.preferences.watchlist.every(item => item.showInBar === false)).toBe(true);
}));
it('ignores obsolete malformed group metadata while retaining a valid total list and backing up the original', () => profile(async (store, path) => {
  const original = JSON.stringify({ ...grouped(), preferences: { ...grouped().preferences, groups: 'obsolete broken metadata', activeViewId: null } });
  await writeFile(path, original); await store.load();
  expect(store.warning).toBe(''); expect(store.preferences.watchlist).toHaveLength(3); expect(await readFile(path + '.v4-backup', 'utf8')).toBe(original);
}));
it('protects the original file when all-watchlist references are incomplete, duplicated, orphaned or untyped', () => profile(async (_store, path) => {
  const good = grouped();
  for (const allView of [[], [good.preferences.allView[0], good.preferences.allView[0], good.preferences.allView[2]],
    [{ symbol: 'US.UNKNOWN', showInBar: true }, ...good.preferences.allView.slice(1)], good.preferences.allView.map(({ symbol }) => ({ symbol }))]) {
    const original = JSON.stringify({ ...good, preferences: { ...good.preferences, allView } }); await writeFile(path, original);
    const store = new SettingsStore(path, cipher); await store.load();
    expect(store.warning).toContain('禁止保存'); await expect(store.save()).rejects.toThrow(); expect(await readFile(path, 'utf8')).toBe(original);
  }
}));
it('does not rewrite or create a backup in diagnostic read-only mode', () => profile(async (store, path) => {
  const original = JSON.stringify(grouped()); await writeFile(path, original); await store.load(false);
  expect(store.preferences.watchlist).toHaveLength(3); expect(await readFile(path, 'utf8')).toBe(original);
  await expect(readFile(path + '.v4-backup')).rejects.toThrow();
}));
it('does not overwrite v4 configuration if its migration backup cannot be written', () => profile(async (store, path) => {
  const original = JSON.stringify(grouped()); await writeFile(path, original); await mkdir(path + '.v4-backup'); await store.load();
  expect(store.warning).toContain('禁止保存'); await expect(store.save()).rejects.toThrow(); expect(await readFile(path, 'utf8')).toBe(original);
}));
it('keeps committed state visible while serialized list and appearance edits are pending', () => profile(async (store, path) => {
  await writeFile(path, JSON.stringify(grouped())); await store.load();
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(done => { entered = done; }); const gate = new Promise<void>(done => { release = done; });
  const previous = structuredClone(store.preferences);
  const reorder = store.update(async current => { entered(); await gate; return { ...current, watchlist: [...current.watchlist].reverse() }; });
  await started; expect(store.preferences).toEqual(previous);
  const appearance = store.update(current => ({ ...current, fontSize: 20 })); release(); await Promise.all([reorder, appearance]);
  expect(store.preferences.watchlist).toEqual([...previous.watchlist].reverse()); expect(store.preferences.fontSize).toBe(20);
  const disk = await readFile(path, 'utf8'); await mkdir(path + '.tmp');
  await expect(store.update(current => ({ ...current, watchlist: [] }))).rejects.toThrow();
  expect(await readFile(path, 'utf8')).toBe(disk); expect(store.preferences.watchlist).toHaveLength(3);
}));
