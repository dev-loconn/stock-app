import { marketItems, type WatchItem, type WatchMarket } from '../shared/stock';

/** Replace only the selected market's slots; edits must retain hidden markets. */
export function mergeMarketWatchlist(items: WatchItem[], market: WatchMarket, next: WatchItem[]): WatchItem[] {
  if (market === 'all') return next;
  const selected = new Set(marketItems(items, market).map(item => item.symbol));
  let index = 0;
  return items.flatMap(item => {
    if (!selected.has(item.symbol)) return [item];
    const replacement = next[index++];
    return replacement ? [replacement] : [];
  });
}

export interface WatchlistDrop { symbol: string; edge: 'before' | 'after' }

export function reorderWatchlist(items: WatchItem[], source: string, target: WatchlistDrop): WatchItem[] {
  const item = items.find(value => value.symbol === source);
  if (!item || source === target.symbol || !items.some(value => value.symbol === target.symbol)) return items;
  const next = items.filter(value => value.symbol !== source);
  const index = next.findIndex(value => value.symbol === target.symbol) + (target.edge === 'after' ? 1 : 0);
  next.splice(index, 0, item);
  return next.every((value, position) => value.symbol === items[position].symbol) ? items : next;
}
