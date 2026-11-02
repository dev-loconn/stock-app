import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SecurityCatalog } from '../src/main/security-catalog';
import type { SecurityMarket, WatchItem } from '../src/shared/stock';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const hk: WatchItem[] = [
  { symbol: 'HK.00700', name: '騰訊控股', securityType: 3 }, { symbol: 'HK.09988', name: '阿里巴巴', securityType: 3 },
  { symbol: 'HK.02800', name: '盈富基金', securityType: 4 },
];
const us: WatchItem[] = [
  { symbol: 'US.AAPL', name: 'Apple Inc.', securityType: 3 }, { symbol: 'US.BABA', name: 'Alibaba Group', securityType: 3 },
  { symbol: 'US.SPY', name: 'SPDR S&P 500 ETF', securityType: 4 }, { symbol: 'US.XAAPL', name: 'Contains Apple', securityType: 3 },
];
async function file() { const folder = await mkdtemp(join(tmpdir(), 'stock-catalog-')); folders.push(folder); return join(folder, 'directory.json'); }

it('matches names, verified aliases, simplified/traditional text, code fragments and pinyin without merging listings', async () => {
  const catalog = new SecurityCatalog(await file(), async market => market === 'HK' ? hk : us);
  await catalog.refresh(true);
  for (const query of ['700', '腾讯', '騰訊', 'Tencent', 'tx', ' xk ']) expect(catalog.search(query).items.map(item => item.symbol)).toContain('HK.00700');
  expect(catalog.search(' aapl ').items[0].symbol).toBe('US.AAPL');
  expect(catalog.search('US.AAPL').items.map(item => item.symbol)).toEqual(['US.AAPL']);
  expect(catalog.search('Alibaba').items.map(item => item.symbol)).toEqual(['HK.09988', 'US.BABA']);
  expect(catalog.search('Alibaba', 'HK').items.map(item => item.symbol)).toEqual(['HK.09988']);
  expect(catalog.search('apple', 'US').items).toHaveLength(2);
  expect(catalog.search('蘋果').items.map(item => item.symbol)).toEqual(['US.AAPL']);
  expect(catalog.search('   ').total).toBe(0);
  expect(() => catalog.search('a', 'XX')).toThrow('搜索条件无效');
  expect(() => catalog.search('x'.repeat(257))).toThrow('搜索条件无效');
});

it('keeps deterministic relevance, limits results to 20 and reports the complete match count', async () => {
  const many = Array.from({ length: 30 }, (_, index) => ({ symbol: `US.T${index}`, name: `Test fund ${index}`, securityType: 4 }));
  many.push({ symbol: 'US.TEST', name: 'Test', securityType: 3 }, { symbol: 'US.XTEST', name: 'Contains test', securityType: 3 });
  const catalog = new SecurityCatalog(await file(), async market => market === 'HK' ? hk : many);
  await catalog.refresh(true);
  const result = catalog.search('test');
  expect(result.items).toHaveLength(20); expect(result.total).toBe(32);
  expect(result.items.findIndex(item => item.symbol === 'US.TEST')).toBeLessThan(20);
  expect(catalog.search('US.TEST').items[0].symbol).toBe('US.TEST');
});

it('persists both successful markets and searches offline after restart without fetching or storing quotes', async () => {
  const path = await file();
  const first = new SecurityCatalog(path, async market => market === 'HK' ? hk : us);
  await Promise.all([first.refresh(true), first.refresh(true)]);
  let calls = 0;
  const offline = new SecurityCatalog(path, async () => { calls++; throw Error('offline'); });
  await offline.load();
  expect(offline.search('腾讯').items[0].symbol).toBe('HK.00700');
  expect(offline.search('apple').items[0].symbol).toBe('US.AAPL');
  expect(calls).toBe(0);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  expect(Object.keys(saved.markets)).toEqual(expect.arrayContaining(['HK', 'US']));
  expect(Object.keys(saved.markets.HK.items[0]).sort()).toEqual(['name', 'securityType', 'symbol']);
});

it('refreshes stale directories once, preserves a failed market and permits a manual retry', async () => {
  let clock = Date.now(); let failed = false;
  const calls: SecurityMarket[] = [];
  const catalog = new SecurityCatalog(await file(), async market => {
    calls.push(market); if (market === 'US' && failed) throw Error('US temporary outage');
    return market === 'HK' ? hk : us;
  }, undefined, () => clock);
  await catalog.refresh(); await catalog.refresh(); expect(calls).toHaveLength(2);
  const original = catalog.state().markets.find(item => item.market === 'US')!.updatedAt;
  clock += 86400001; failed = true; await catalog.refresh();
  expect(catalog.state().markets.find(item => item.market === 'HK')!.updatedAt).toBe(clock);
  expect(catalog.state().markets.find(item => item.market === 'US')).toMatchObject({ updatedAt: original, error: 'US temporary outage', count: us.length });
  expect(catalog.search('apple').items[0].symbol).toBe('US.AAPL');
  await catalog.refresh(); expect(calls).toHaveLength(4);
  failed = false; await catalog.refresh(true);
  expect(catalog.state().markets.every(item => !item.error && item.updatedAt === clock)).toBe(true);
});

it('does not replace usable data with an empty or malformed response and independently loads a valid market', async () => {
  const path = await file(); let invalid = false;
  const catalog = new SecurityCatalog(path, async market => invalid ? [] : market === 'HK' ? hk : us);
  await catalog.refresh(true); invalid = true; await catalog.refresh(true);
  expect(catalog.search('腾讯').items).toHaveLength(1);
  expect(catalog.state().markets.every(item => Boolean(item.error))).toBe(true);
  const saved = JSON.parse(await readFile(path, 'utf8')); saved.markets.US.items[0].symbol = 'CN.INVALID';
  await writeFile(path, JSON.stringify(saved));
  const reloaded = new SecurityCatalog(path, async () => []); await reloaded.load();
  expect(reloaded.search('腾讯').items).toHaveLength(1);
  expect(reloaded.state().markets.find(item => item.market === 'US')).toMatchObject({ count: 0, error: expect.any(String) });
});
