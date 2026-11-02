import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { expect, it } from 'vitest';
import { AKShareDirectory, directoryProcessError } from '../src/main/akshare-directory';
import { SecurityCatalog } from '../src/main/security-catalog';
import { normalizeSymbol, SECURITY_MARKETS, type SecurityMarket, type WatchItem } from '../src/shared/stock';

const data: Record<SecurityMarket, WatchItem[]> = {
  HK: [{ symbol: 'HK.00700', name: '騰訊控股', aliases: ['Tencent Holdings'], securityType: 0 }],
  US: [{ symbol: 'US.AAPL', name: '苹果', aliases: ['Apple Inc.'], securityType: 0 }],
  SH: [{ symbol: 'SH.600519', name: '贵州茅台', securityType: 0 }],
  SZ: [{ symbol: 'SZ.000001', name: '平安银行', securityType: 0 }],
  BJ: [{ symbol: 'BJ.920001', name: '纬达光电', securityType: 0 }],
};
it('does not render a missing stderr error field as undefined', () => {
  for (const stderr of ['', '{}', '{"message":"unstructured"}']) {
    expect(directoryProcessError({ code: 1 }, stderr).message).not.toContain('undefined');
  }
});
it('reports environment, cancellation and timeout failures without leaking worker output', () => {
  expect(directoryProcessError({ code: 'EACCES' }, '').message).toContain('运行环境');
  expect(directoryProcessError({ code: 1 }, '{"error":"ModuleNotFoundError"}').message).toContain('运行环境');
  expect(directoryProcessError({ code: 'ABORT_ERR' }, '').message).toContain('取消');
  expect(directoryProcessError({ killed: true }, '').message).toContain('超时');
  expect(directoryProcessError({ code: 1 }, 'proxy://test-user:test-secret@local.invalid').message).not.toContain('test-secret');
});
it('uses the packaged interpreter before the project venv and system Python', async () => {
  await mkdir(resolve('artifacts'), { recursive: true });
  const directory = await mkdtemp(resolve('artifacts/akshare-runtime-test-'));
  const previous = process.env.STOCK_BAR_PYTHON;
  delete process.env.STOCK_BAR_PYTHON;
  let selected = '';
  const source = new AKShareDirectory(directory, async python => {
    selected = python;
    return JSON.stringify({version: 1, source: 'akshare', market: 'HK', items: data.HK});
  });
  try {
    const bundled = join(directory, 'runtime', 'python', 'python.exe');
    const local = join(directory, '.cache', 'akshare-venv', 'Scripts', 'python.exe');
    for (const path of [bundled, local]) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, 'fixture'); }
    await source.fetch('HK'); expect(selected).toBe(bundled);
    process.env.STOCK_BAR_PYTHON = 'explicit-interpreter';
    await source.fetch('HK'); expect(selected).toBe('explicit-interpreter');
    delete process.env.STOCK_BAR_PYTHON;
    const incomplete = new AKShareDirectory(join(directory, 'incomplete'), async () => {
      throw Error('must not launch a system Python alias');
    }, { requireBundled: true });
    await expect(incomplete.fetch('HK')).rejects.toThrow('完整解压');
    incomplete.stop();
  } finally {
    source.stop();
    if (previous === undefined) delete process.env.STOCK_BAR_PYTHON; else process.env.STOCK_BAR_PYTHON = previous;
    if (dirname(directory) !== resolve('artifacts')) throw Error('Unexpected fixture path');
    await rm(directory, { recursive: true });
  }
});
it('does not invent undefined error details when a worker fails without structured stderr', async () => {
  const previous = process.env.STOCK_BAR_PYTHON;
  // Node rejects Python's -u flag. This exercises the real failed-process callback.
  process.env.STOCK_BAR_PYTHON = process.execPath;
  const source = new AKShareDirectory(resolve('.'));
  try {
    const message = await source.fetch('HK').then(() => '', error => error.message);
    expect(message).toContain('AKShare');
    expect(message).not.toMatch(/undefined|null|\[object Object\]/);
  } finally {
    source.stop();
    if (previous === undefined) delete process.env.STOCK_BAR_PYTHON; else process.env.STOCK_BAR_PYTHON = previous;
  }
});
it('syncs five markets, persists bilingual aliases and serves ranked A-share searches offline after restart', async () => {
  await mkdir(resolve('artifacts'), { recursive: true });
  const directory = await mkdtemp(resolve('artifacts/akshare-test-'));
  let fail = false;
  const source = new AKShareDirectory(resolve('.'), async (_python, args) => {
    const market = args.at(-1) as SecurityMarket;
    if (market === 'US' && fail) throw Error('source unavailable');
    return JSON.stringify({ version: 1, source: 'akshare', market, items: data[market] });
  });
  try {
    const path = join(directory, 'catalog.json');
    const catalog = new SecurityCatalog(path, market => source.fetch(market), undefined, Date.now, SECURITY_MARKETS);
    await Promise.all([catalog.refresh(true), catalog.refresh(true)]);
    expect(catalog.state().markets.every(item => item.count === 1 && !item.error)).toBe(true);
    for (const query of ['贵州', '貴州', 'gzmt', '6005', 'sh.600519']) expect(catalog.search(query, 'CN').items[0].symbol).toBe('SH.600519');
    expect(catalog.search('payh', 'CN').items[0].symbol).toBe('SZ.000001');
    expect(catalog.search('Apple').items[0].symbol).toBe('US.AAPL');
    expect(catalog.search('Tencent').items[0].symbol).toBe('HK.00700');
    expect(catalog.search('苹果', 'CN').total).toBe(0);
    const offline = new SecurityCatalog(path, async () => { throw Error('offline'); }, undefined, Date.now, SECURITY_MARKETS);
    await offline.load(); expect(offline.search('apple').items[0].symbol).toBe('US.AAPL');
    fail = true; await catalog.refresh(true);
    expect(catalog.search('apple').items).toHaveLength(1);
    expect(catalog.state().markets.find(item => item.market === 'US')).toMatchObject({ count: 1, error: 'source unavailable' });
    fail = false; await catalog.refresh(true, ['US']);
    const reloaded = new SecurityCatalog(path, async () => [], undefined, Date.now, SECURITY_MARKETS);
    await reloaded.load(); expect(reloaded.state().markets.every(item => item.count === 1)).toBe(true);
    const cache = await readFile(path, 'utf8');
    expect(cache).not.toContain('last_price'); expect(cache).not.toContain('token');
    for (const market of SECURITY_MARKETS) expect(normalizeSymbol(data[market][0].symbol.toLowerCase())).toBe(data[market][0].symbol);
  } finally { source.stop(); await rm(directory, { recursive: true }); }
});

it('rejects mismatched/empty data and recovers the process queue after failures', async () => {
  let output = '{}';
  const source = new AKShareDirectory(resolve('.'), async () => output);
  await expect(source.fetch('HK')).rejects.toThrow('不匹配');
  output = JSON.stringify({ version: 1, source: 'akshare', market: 'HK', items: [] });
  await expect(source.fetch('HK')).rejects.toThrow('保留已有目录');
  output = JSON.stringify({ version: 1, source: 'akshare', market: 'HK', items: data.HK });
  expect(await source.fetch('HK')).toEqual(data.HK);
  source.stop(); await expect(source.fetch('HK')).rejects.toThrow('取消');
});

it('merges independent app and CLI writers without dropping another market from disk', async () => {
  await mkdir(resolve('artifacts'), { recursive: true });
  const directory = await mkdtemp(resolve('artifacts/akshare-writers-'));
  try {
    const path = join(directory, 'catalog.json');
    const app = new SecurityCatalog(path, async () => data.HK, undefined, Date.now, ['HK']);
    const cli = new SecurityCatalog(path, async () => data.US, undefined, Date.now, ['US']);
    await Promise.all([app.refresh(true), cli.refresh(true)]);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    expect(saved.markets.HK.items[0].symbol).toBe('HK.00700');
    expect(saved.markets.US.items[0].symbol).toBe('US.AAPL');
  } finally { await rm(directory, { recursive: true }); }
});
