import { expect, it } from 'vitest';
import type { WatchItem } from '../src/shared/stock';
import { mergeMarketWatchlist, reorderWatchlist } from '../src/renderer/watchlist-order';

const items: WatchItem[] = ['US.AAPL', 'HK.00700', 'US.TSLA', 'US.SPY'].map(symbol => ({ symbol, name: symbol, securityType: 3 }));
const symbols = (list: WatchItem[]) => list.map(item => item.symbol);

it('moves a filtered security first without losing or reordering other markets', () => {
  const us = items.filter(item => item.symbol.startsWith('US.'));
  const next = reorderWatchlist(us, 'US.SPY', { symbol: 'US.AAPL', edge: 'before' });
  const merged = mergeMarketWatchlist(items, 'US', next);
  expect(symbols(merged)).toEqual(['US.SPY', 'HK.00700', 'US.AAPL', 'US.TSLA']);
  expect(merged[1]).toBe(items[1]);
  expect(symbols(mergeMarketWatchlist(items, 'all', reorderWatchlist(items, 'US.SPY', { symbol: 'US.AAPL', edge: 'before' }))))
    .toEqual(['US.SPY', 'US.AAPL', 'HK.00700', 'US.TSLA']);
});

it('retains hidden markets when selecting or removing securities in a filtered list', () => {
  const next = items.filter(item => item.symbol.startsWith('US.') && item.symbol !== 'US.TSLA')
    .map(item => ({ ...item, showInBar: false }));
  const merged = mergeMarketWatchlist(items, 'US', next);
  expect(symbols(merged)).toEqual(['US.AAPL', 'HK.00700', 'US.SPY']);
  expect(merged[1]).toBe(items[1]);
  expect(merged[0].showInBar).toBe(false);
  expect(symbols(mergeMarketWatchlist(items, 'US', []))).toEqual(['HK.00700']);
  expect(mergeMarketWatchlist(items, 'HK', [items[1]])).toEqual(items);
});

it('inserts above or below a target in either direction without changing security details', () => {
  expect(symbols(reorderWatchlist(items, 'US.AAPL', { symbol: 'US.TSLA', edge: 'after' })))
    .toEqual(['HK.00700', 'US.TSLA', 'US.AAPL', 'US.SPY']);
  expect(symbols(reorderWatchlist(items, 'US.AAPL', { symbol: 'US.SPY', edge: 'before' })))
    .toEqual(['HK.00700', 'US.TSLA', 'US.AAPL', 'US.SPY']);
  expect(symbols(reorderWatchlist(items, 'US.SPY', { symbol: 'US.AAPL', edge: 'before' })))
    .toEqual(['US.SPY', 'US.AAPL', 'HK.00700', 'US.TSLA']);
  const moved = reorderWatchlist(items, 'US.TSLA', { symbol: 'US.AAPL', edge: 'after' });
  expect(symbols(moved)).toEqual(['US.AAPL', 'US.TSLA', 'HK.00700', 'US.SPY']);
  expect(moved[1]).toBe(items[2]);
  expect(symbols(items)).toEqual(['US.AAPL', 'HK.00700', 'US.TSLA', 'US.SPY']);
});

it('does not save a no-op, an unknown security, or an empty list', () => {
  for (const [source, symbol, edge] of [
    ['US.AAPL', 'US.AAPL', 'after'], ['US.AAPL', 'HK.00700', 'before'],
    ['HK.00700', 'US.AAPL', 'after'], ['US.UNKNOWN', 'US.AAPL', 'before'],
    ['US.AAPL', 'US.UNKNOWN', 'after'],
  ] as const) expect(reorderWatchlist(items, source, { symbol, edge })).toBe(items);
  const empty: WatchItem[] = [];
  expect(reorderWatchlist(empty, 'US.AAPL', { symbol: 'HK.00700', edge: 'before' })).toBe(empty);
});
