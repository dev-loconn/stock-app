import type { WatchItem } from '../shared/stock';

export interface WatchlistDrop { symbol: string; edge: 'before' | 'after' }

export function reorderWatchlist(items: WatchItem[], source: string, target: WatchlistDrop): WatchItem[] {
  const item = items.find(value => value.symbol === source);
  if (!item || source === target.symbol || !items.some(value => value.symbol === target.symbol)) return items;
  const next = items.filter(value => value.symbol !== source);
  const index = next.findIndex(value => value.symbol === target.symbol) + (target.edge === 'after' ? 1 : 0);
  next.splice(index, 0, item);
  return next.every((value, position) => value.symbol === items[position].symbol) ? items : next;
}
