import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DEFAULT_SHORTCUTS, upgradeShortcutDefaults, validateShortcuts, type ShortcutBindings } from '../shared/shortcuts';
import { DEFAULT_PREFERENCES, normalizeSymbol, validateAppearance, validateConnection, type Preferences, type WatchItem } from '../shared/stock';

interface Cipher { available: () => boolean; encrypt: (text: string) => Buffer; decrypt: (data: Buffer) => string }
function readWatchlist(value: unknown, requireSelection = true): WatchItem[] {
  if (!Array.isArray(value)) throw Error('自选配置无效');
  const items = value.map(item => {
    const symbol = normalizeSymbol(item?.symbol);
    if (typeof item.name !== 'string' || ![3, 4].includes(item.securityType)) throw Error('自选配置无效');
    if (item.showInBar !== undefined && typeof item.showInBar !== 'boolean' || requireSelection && typeof item.showInBar !== 'boolean') throw Error('展示选择配置无效');
    return { symbol, name: item.name.slice(0, 100), securityType: item.securityType,
      ...(Array.isArray(item.aliases) && item.aliases.every((alias: unknown) => typeof alias === 'string') ? { aliases: item.aliases } : {}), showInBar: item.showInBar ?? true };
  });
  if (new Set(items.map(item => item.symbol)).size !== items.length) throw Error('自选配置重复');
  return items;
}
function flattenVersion4(watchlist: WatchItem[], allView: unknown): WatchItem[] {
  if (!Array.isArray(allView) || allView.length !== watchlist.length) throw Error('全部自选配置无效');
  const indexed = new Map(watchlist.map(item => [item.symbol, item]));
  const seen = new Set<string>();
  return allView.map(member => {
    const symbol = normalizeSymbol(member?.symbol);
    if (!indexed.has(symbol) || seen.has(symbol) || typeof member.showInBar !== 'boolean') throw Error('全部自选配置无效');
    seen.add(symbol);
    return { ...indexed.get(symbol)!, showInBar: member.showInBar };
  });
}
export class SettingsStore {
  preferences: Preferences = structuredClone(DEFAULT_PREFERENCES);
  key = '';
  keySaved = false;
  warning = '';
  private encryptedKey?: string;
  private writes: Promise<void> = Promise.resolve();
  private protectedFile = false;
  constructor(private path: string, private cipher: Cipher) {}

  async load(persistMigration = true): Promise<void> {
    try {
      const original = await readFile(this.path, 'utf8');
      const data = JSON.parse(original) as Record<string, unknown>;
      if (typeof data.version !== 'number' || ![1, 2, 3, 4, 5].includes(data.version)) throw Error('配置版本不受支持');
      const source = data.preferences as Preferences;
      // Version 1 stored the whole-window width. Never interpret that as an item width.
      const legacy = data.version === 1 || data.version === 2;
      const appearance = validateAppearance({ ...source,
        ...(data.version === 1 ? { securityWidth: DEFAULT_PREFERENCES.securityWidth } : {}),
        ...(legacy ? { barPageSize: source.barPageSize ?? DEFAULT_PREFERENCES.barPageSize } : {}) });
      validateConnection({ ...source, rememberKey: false });
      let watchlist = readWatchlist(source.watchlist, data.version === 3 || data.version === 5);
      if (data.version === 4) watchlist = flattenVersion4(watchlist, (source as unknown as Record<string, unknown>).allView);
      if (source.connectionMode !== undefined && !['cloud', 'opend'].includes(source.connectionMode)) throw Error('连接方式无效');
      this.preferences = { connectionMode: source.connectionMode || 'cloud', host: source.host, port: source.port, ssl: source.ssl,
        ...appearance, watchlist, shortcuts: structuredClone(DEFAULT_SHORTCUTS) };
      // A damaged hotkey section must not discard the watchlist or protected connection.
      let shortcutDefaultsMigrated = false;
      if (source.shortcuts !== undefined) {
        try {
          const saved = validateShortcuts(source.shortcuts);
          const upgraded = Number(data.shortcutDefaultsVersion || 0) < 1 ? upgradeShortcutDefaults(saved) : saved;
          shortcutDefaultsMigrated = JSON.stringify(saved) !== JSON.stringify(upgraded);
          this.preferences.shortcuts = upgraded;
        }
        catch { this.warning = '快捷键配置无效，已使用默认快捷键；其他设置保留'; }
      }
      if (source.position && Number.isFinite(source.position.x) && Number.isFinite(source.position.y)) {
        this.preferences.position = { x: Math.round(source.position.x), y: Math.round(source.position.y) };
      }
      if (typeof data.encryptedKey === 'string') {
        try {
          if (!this.cipher.available()) throw new Error();
          this.key = this.cipher.decrypt(Buffer.from(data.encryptedKey, 'base64'));
          this.encryptedKey = data.encryptedKey; this.keySaved = true;
        } catch { this.warning = '保存的密钥无法读取，请重新填写'; }
      }
      if (data.version === 4 && persistMigration) {
        // Keep the complete old configuration, including group-specific choices, before flattening.
        try { await writeFile(this.path + '.v4-backup', original, { flag: 'wx', mode: 0o600 }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          if (await readFile(this.path + '.v4-backup', 'utf8') !== original) await writeFile(this.path + '.v4-backup-' + Date.now(), original, { flag: 'wx', mode: 0o600 });
        }
      }
      if ((data.version !== 5 || shortcutDefaultsMigrated) && !this.warning && persistMigration) {
        try { await this.save(); } catch { this.warning = '配置已迁移，暂时无法保存；下次保存设置时重试'; }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.preferences = structuredClone(DEFAULT_PREFERENCES);
        this.protectedFile = true;
        this.warning = '配置无法读取，旧配置未覆盖；请备份并修复配置后重启，暂时禁止保存';
      }
    }
  }
  async setConnection(value: unknown): Promise<void> {
    const input = validateConnection(value);
    const nextKey = input.clearKey ? '' : input.key || this.key;
    let encryptedKey: string | undefined;
    if (input.rememberKey && nextKey) {
      if (!this.cipher.available()) throw new Error('系统保护不可用，请取消记住密钥，以会话方式连接');
      encryptedKey = this.cipher.encrypt(nextKey).toString('base64');
    }
    await this.enqueue(async () => {
      const next = { ...this.preferences, connectionMode: 'opend' as const, host: input.host, port: input.port, ssl: input.ssl };
      await this.write(next, encryptedKey);
      this.preferences = next; this.key = nextKey; this.encryptedKey = encryptedKey; this.keySaved = Boolean(encryptedKey);
    });
  }
  setShortcuts(shortcuts: ShortcutBindings): Promise<void> { return this.save(shortcuts); }
  private enqueue(operation: () => Promise<void>): Promise<void> {
    this.writes = this.writes.catch(() => undefined).then(async () => {
      if (this.protectedFile) throw Error(this.warning);
      await operation();
    });
    return this.writes;
  }
  private async write(preferences: Preferences, encryptedKey: string | undefined) {
    const data = JSON.stringify({ version: 5, shortcutDefaultsVersion: 1, preferences, encryptedKey }, null, 2) + '\n';
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path + '.tmp', data, 'utf8');
    await rename(this.path + '.tmp', this.path);
  }
  update(change: (current: Preferences) => Preferences | Promise<Preferences>): Promise<void> {
    return this.enqueue(async () => {
      const next = await change(structuredClone(this.preferences));
      next.watchlist = readWatchlist(next.watchlist);
      await this.write(next, this.encryptedKey);
      this.preferences = next;
    });
  }
  save(shortcuts?: ShortcutBindings): Promise<void> {
    // Only preferences and an OS-protected secret are persisted. Never write quotes or runtime state.
    // Serialize when this write runs so another settings update cannot overwrite a newer shortcut commit.
    return this.enqueue(async () => {
      const current = shortcuts ? { ...this.preferences, shortcuts } : this.preferences;
      await this.write(current, this.encryptedKey);
      if (shortcuts) this.preferences = { ...this.preferences, shortcuts };
    });
  }
}
