import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pinyin } from 'pinyin-pro';
import { normalizeSymbol, matchesMarket, SECURITY_MARKETS, type DirectoryState, type SecurityMarket, type SecuritySearch, type WatchItem } from '../shared/stock';
import { SECURITY_ALIASES } from './security-aliases';

const OpenCC = require('opencc-js') as { Converter: (options: { from: string; to: string }) => (text: string) => string };
const simplify = OpenCC.Converter({ from: 't', to: 'cn' });
const DAY = 86400000;
interface IndexItem { item: WatchItem; fields: string[] }
interface MarketData { updatedAt: number; items: WatchItem[] }
const fold = (text: string) => simplify(text.trim()).toLowerCase();

export function validateDirectory(items: unknown, market: SecurityMarket): WatchItem[] {
  if (!Array.isArray(items) || items.length > 100000) throw Error('证券目录格式无效');
  const result = new Map<string, WatchItem>();
  for (const value of items) {
    if (!value || typeof value !== 'object') throw Error('证券目录条目无效');
    const symbol = normalizeSymbol(value.symbol);
    if (!symbol.startsWith(market + '.') || typeof value.name !== 'string' || !value.name.trim()
      || value.name.length > 200 || ![0, 3, 4].includes(value.securityType)) throw Error('证券目录条目无效');
    if (value.aliases !== undefined && (!Array.isArray(value.aliases) || value.aliases.length > 20
      || value.aliases.some((name: unknown) => typeof name !== 'string' || !name.trim() || name.length > 200))) throw Error('证券别名无效');
    result.set(symbol, { symbol, name: value.name.trim(), securityType: value.securityType,
      ...(value.aliases?.length ? { aliases: [...new Set<string>(value.aliases.map((name: string) => name.trim()))] } : {}) });
  }
  if (!result.size) throw Error('未取得有效证券目录，保留已有目录');
  return [...result.values()];
}

async function buildIndex(items: WatchItem[]): Promise<IndexItem[]> {
  const index: IndexItem[] = [];
  for (let position = 0; position < items.length; position++) {
    const item = items[position];
    const names = [...new Set([item.name, ...(item.aliases || []), ...(SECURITY_ALIASES[item.symbol] || [])].map(fold))];
    const initials = names.filter(name => /\p{Script=Han}/u.test(name)).map(name => pinyin(name, {
      pattern: 'first', toneType: 'none', type: 'array', nonZh: 'removed',
    }).join('').toLowerCase());
    index.push({ item, fields: [...new Set([item.symbol.toLowerCase(), item.symbol.slice(3).toLowerCase(), ...names, ...initials])] });
    // Large directories must not monopolize the quote/heartbeat event loop.
    if (position % 100 === 99) await new Promise<void>(done => setImmediate(done));
  }
  return index;
}

export class SecurityCatalog {
  private data: Partial<Record<SecurityMarket, MarketData>> = {};
  private indexes: Partial<Record<SecurityMarket, IndexItem[]>> = {};
  private errors: Partial<Record<SecurityMarket, string>> = {};
  private attempts: Partial<Record<SecurityMarket, number>> = {};
  private pending: Partial<Record<SecurityMarket, Promise<void>>> = {};
  private writes: Promise<void> = Promise.resolve();
  constructor(private path: string, private fetchMarket: (market: SecurityMarket) => Promise<WatchItem[]>,
    private publish: () => void = () => undefined, private now = Date.now,
    private markets: SecurityMarket[] = ['HK', 'US']) {}

  state(): DirectoryState {
    return { markets: this.markets.map(market => ({ market, count: this.data[market]?.items.length || 0,
      updatedAt: this.data[market]?.updatedAt, refreshing: Boolean(this.pending[market]), error: this.errors[market] })) };
  }
  async load(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'));
      if (value.version !== 1 || !value.markets || typeof value.markets !== 'object') throw Error('目录格式无效');
      for (const market of this.markets) {
        if (!value.markets[market]) continue;
        try {
          const { updatedAt, items: source } = value.markets[market];
          if (!Number.isFinite(updatedAt) || updatedAt <= 0 || updatedAt > this.now() + 300000) throw Error();
          const items = validateDirectory(source, market);
          this.indexes[market] = await buildIndex(items); this.data[market] = { updatedAt, items };
        } catch { this.errors[market] = '本地目录无法读取，请连接后刷新'; }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        for (const market of this.markets) this.errors[market] = '本地目录无法读取，请刷新';
      }
    }
  }
  search(query: unknown, market: unknown = 'all'): SecuritySearch {
    if (typeof query !== 'string' || query.length > 256 || !['all', 'CN', ...SECURITY_MARKETS].includes(String(market))) throw Error('搜索条件无效');
    const needle = fold(query);
    if (!needle) return { items: [], total: 0, directory: this.state() };
    const results: { item: WatchItem; rank: number }[] = [];
    for (const current of this.markets) {
      if (!matchesMarket(current, market)) continue;
      for (const { item, fields } of this.indexes[current] || []) {
        const rank = fields.includes(needle) ? 0 : fields.some(field => field.startsWith(needle)) ? 1
          : fields.some(field => field.includes(needle)) ? 2 : 3;
        if (rank < 3) results.push({ item, rank });
      }
    }
    results.sort((left, right) => left.rank - right.rank || left.item.symbol.localeCompare(right.item.symbol, 'en'));
    return { items: results.slice(0, 20).map(({ item }) => structuredClone(item)), total: results.length, directory: this.state() };
  }
  async refresh(force = false, requested: SecurityMarket[] = this.markets): Promise<DirectoryState> {
    if (requested.some(market => !this.markets.includes(market))) throw Error('同步市场无效');
    await Promise.all([...new Set(requested)].map(market => {
      if (this.pending[market]) return this.pending[market];
      const now = this.now();
      if (!force && (now - (this.data[market]?.updatedAt || 0) < DAY || now - (this.attempts[market] || 0) < 300000)) return;
      this.attempts[market] = now;
      const task = this.refreshMarket(market).finally(() => { this.attempts[market] = this.now(); delete this.pending[market]; this.publish(); });
      this.pending[market] = task;
      this.publish();
      return task;
    }));
    return this.state();
  }
  private async refreshMarket(market: SecurityMarket): Promise<void> {
    try {
      const items = validateDirectory(await this.fetchMarket(market), market);
      const index = await buildIndex(items);
      const next = { updatedAt: this.now(), items };
      // Commit each successful market serially so simultaneous refreshes cannot overwrite each other.
      this.writes = this.writes.catch(() => undefined).then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        const lockPath = this.path + '.lock';
        const deadline = Date.now() + 5000;
        let lock;
        while (!lock) {
          try { lock = await open(lockPath, 'wx', 0o600); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            // Recover locks left by a terminated process; a normal atomic save takes milliseconds.
            try { if (Date.now() - (await stat(lockPath)).mtimeMs > 30000) { await unlink(lockPath); continue; } } catch { /* Another writer released it. */ }
            if (Date.now() >= deadline) throw Error('另一进程正在保存目录，请稍后刷新');
            await new Promise(done => setTimeout(done, 50));
          }
        }
        const temporary = `${this.path}.${process.pid}.tmp`;
        try {
          const snapshot = { ...this.data };
          // Merge the newest disk markets so a CLI sync and app refresh cannot erase each other.
          try {
            const disk = JSON.parse(await readFile(this.path, 'utf8'));
            if (disk.version === 1) for (const current of SECURITY_MARKETS) {
              const saved = disk.markets?.[current];
              if (Number.isFinite(saved?.updatedAt) && saved.updatedAt > (snapshot[current]?.updatedAt || 0) && saved.updatedAt <= this.now() + 300000) {
                try { snapshot[current] = { updatedAt: saved.updatedAt, items: validateDirectory(saved.items, current) }; } catch { /* Keep valid in-memory data. */ }
              }
            }
          } catch { /* Missing/corrupt cache is replaced with validated data. */ }
          snapshot[market] = next;
          await writeFile(temporary, JSON.stringify({ version: 1, markets: snapshot }) + '\n', { encoding: 'utf8', mode: 0o600 });
          await rename(temporary, this.path);
        } finally {
          await unlink(temporary).catch(() => undefined);
          await lock.close(); await unlink(lockPath).catch(() => undefined);
        }
        this.data[market] = next; this.indexes[market] = index;
      });
      await this.writes;
      delete this.errors[market];
    } catch (error) { this.errors[market] = error instanceof Error ? error.message.slice(0, 250) : '目录刷新失败'; }
  }
}
