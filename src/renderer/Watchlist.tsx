import { useRef, useState, type DragEvent } from 'react';
import type { WatchItem } from '../shared/stock';
import { reorderWatchlist, type WatchlistDrop } from './watchlist-order';

export function Watchlist({ items, busy, onChange }: {
  items: WatchItem[]; busy: boolean; onChange: (items: WatchItem[]) => void;
}) {
  const [removing, setRemoving] = useState<string>();
  const source = useRef<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [target, setTarget] = useState<WatchlistDrop | null>(null);
  const clear = () => { source.current = null; setDragging(null); setTarget(null); };
  const dropAt = (event: DragEvent<HTMLLIElement>, symbol: string): WatchlistDrop => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { symbol, edge: event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after' };
  };
  return <>
    <p className="muted watchlist-hint" id="watchlist-drag-hint">{items.length ? '勾选后在悬浮条显示；拖动手柄或点击“移到最前”调整当前分组顺序。修改后自动保存。' : '当前分组暂无自选证券，可在下方搜索添加。'}</p>
    <ul className="watchlist" aria-label="自选证券列表" tabIndex={items.length ? 0 : undefined} aria-busy={busy} onDragLeave={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTarget(null);
    }}>
      {items.map((item, index) => <li key={item.symbol} data-symbol={item.symbol}
        className={[dragging === item.symbol ? 'is-dragging' : '', target?.symbol === item.symbol ? `drop-${target.edge}` : ''].filter(Boolean).join(' ')}
        onDragOver={event => {
          if (busy || !source.current) return;
          event.preventDefault(); event.dataTransfer.dropEffect = 'move';
          setTarget(source.current === item.symbol ? null : dropAt(event, item.symbol));
        }} onDrop={event => {
          if (busy || !source.current) { clear(); return; }
          event.preventDefault();
          const next = reorderWatchlist(items, source.current, dropAt(event, item.symbol));
          clear();
          if (next !== items) onChange(next);
        }}>
        <button className="watchlist-drag-handle" type="button" draggable={!busy && items.length > 1}
          disabled={busy || items.length < 2} aria-label={`拖动排序 ${item.name} ${item.symbol}`} aria-describedby="watchlist-drag-hint" title="拖动调整顺序"
          onDragStart={event => {
            if (busy || items.length < 2) { event.preventDefault(); return; }
            source.current = item.symbol; setDragging(item.symbol);
            event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.symbol);
            const row = event.currentTarget.closest('li');
            if (row) event.dataTransfer.setDragImage(row, 20, row.clientHeight / 2);
          }} onDragEnd={clear}>⠿</button>
        <div className="watchlist-security"><strong>{item.name}</strong><span>{item.symbol}</span></div>
        <div className="list-actions"><label className="bar-selection"><input type="checkbox" checked={item.showInBar !== false} disabled={busy}
          aria-label={`在悬浮条显示 ${item.name} ${item.symbol}`} onChange={event => onChange(items.map(existing => existing.symbol === item.symbol ? { ...existing, showInBar: event.target.checked } : existing))} />显示在悬浮条</label>
          <button className="move-first" disabled={busy || index === 0} aria-label={`移到最前 ${item.name} ${item.symbol}`}
            onClick={() => onChange(reorderWatchlist(items, item.symbol, { symbol: items[0].symbol, edge: 'before' }))}>移到最前</button>
          <button className="remove" disabled={busy}
          aria-label={`移除自选 ${item.name} ${item.symbol}`} onClick={() => setRemoving(item.symbol)}>移除自选</button></div>
        {removing === item.symbol && <div className="watchlist-confirm" role="alert">确认移除这只自选证券？
          <button disabled={busy} onClick={() => { setRemoving(undefined); onChange(items.filter(existing => existing.symbol !== item.symbol)); }}>确认移除</button>
          <button disabled={busy} onClick={() => setRemoving(undefined)}>取消</button></div>}
      </li>)}
    </ul>
  </>;
}
