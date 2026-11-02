import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { SearchMarket, SecuritySearch, StockState } from '../shared/stock';
import { MARKET_NAMES, matchesMarket, type SecurityMarket } from '../shared/stock';

export function SecuritySearchPanel({ state, busy, onAdd }: {
  state?: StockState; busy: boolean; onAdd: (symbol: string) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [market, setMarket] = useState<SearchMarket>('all');
  const [result, setResult] = useState<SecuritySearch>();
  const [selected, setSelected] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [composing, setComposing] = useState(false);
  const [error, setError] = useState('');
  const [refreshMessage, setRefreshMessage] = useState('');
  const composingRef = useRef(false);
  const connected = state?.connection === 'connected';
  const watchlist = state?.preferences.watchlist || [];
  const directory = state?.directory || result?.directory;
  const stamp = directory?.markets.map(item => `${item.market}:${item.updatedAt}:${item.error}`).join('|') || '';
  const relevant = directory?.markets.filter(item => matchesMarket(item.market, market)) || [];
  const available = relevant.some(item => item.count > 0);
  const refreshing = directory?.markets.some(item => item.refreshing) || false;
  const symbol = query.trim().toUpperCase();
  const exactCode = /^(HK\.\d{5}|US\.[A-Z][A-Z0-9.-]{0,19}|(?:SH|SZ|BJ)\.\d{6})$/.test(symbol);

  useEffect(() => {
    let cancelled = false;
    setSelected(undefined);
    if (!query.trim() || composing) { setResult(undefined); setLoading(false); return; }
    setLoading(true); setError('');
    const timer = setTimeout(() => {
      void window.stockBar.search(query, market).then(value => { if (!cancelled) setResult(value); })
        .catch(reason => { if (!cancelled) { setError(reason instanceof Error ? reason.message : '搜索失败，请重试'); setResult(undefined); } })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, market, composing, stamp]);

  const disabledReason = (value: string) => watchlist.some(item => item.symbol === value) ? '已添加'
    : busy ? '处理中…'
    : value.startsWith('BJ.') && state?.preferences.connectionMode === 'opend' ? '请切换富途云端' : !connected ? '连接后添加' : '';
  const add = (value: string) => { if (!disabledReason(value) && !loading && !composingRef.current) void onAdd(value); };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    const items = result?.items || [];
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && items.length && !loading) {
      event.preventDefault();
      const index = items.findIndex(item => item.symbol === selected);
      const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1)
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      setSelected(items[next].symbol);
      document.getElementById(`search-${items[next].symbol}`)?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter' && selected) { event.preventDefault(); add(selected); }
    else if (event.key === 'Escape') setSelected(undefined);
  };
  const updateQuery = (value: string) => { setQuery(value); setSelected(undefined); setResult(undefined); setError(''); };

  return <div className="security-search">
    <label htmlFor="security-query">搜索证券</label>
    <div className="search-toolbar">
      <input id="security-query" aria-label="搜索证券" role="combobox" autoComplete="off" maxLength={256}
        aria-autocomplete="list" aria-controls="security-results" aria-expanded={Boolean(result?.items.length)}
        aria-activedescendant={selected ? `search-${selected}` : undefined}
        value={query} placeholder="代码、中文 / 英文名称、拼音首字母" onChange={event => updateQuery(event.target.value)} onKeyDown={keyDown}
        onCompositionStart={() => { composingRef.current = true; setComposing(true); setSelected(undefined); }}
        onCompositionEnd={() => { composingRef.current = false; setComposing(false); }} />
      <select aria-label="搜索市场" value={market} onChange={event => { setMarket(event.target.value as SearchMarket); setResult(undefined); }}>
        <option value="all">全部市场</option><option value="HK">港股</option><option value="US">美股</option><option value="CN">A 股</option>
      </select>
      <button className="directory-refresh" disabled={refreshing} onClick={() => {
        setRefreshMessage('');
        void window.stockBar.refreshDirectory().then(value => setRefreshMessage(value.message || (value.ok ? '目录已更新' : '目录刷新失败')))
          .catch(() => setRefreshMessage('目录刷新失败，请重试'));
      }}>{refreshing ? '更新中…' : '刷新目录'}</button>
    </div>
    {refreshMessage && <p className="muted" role="status">{refreshMessage}</p>}
    <div className="search-feedback" role="status" aria-live="polite">
      {error ? <span className="search-error">{error}</span> : !query.trim() ? '输入代码、名称或拼音首字母查找证券'
        : composing ? '正在输入…' : loading ? '正在搜索…' : !available ? (relevant.some(item => item.refreshing) ? '正在加载证券目录…' : '请刷新证券目录，也可输入完整代码核验添加')
          : result?.total ? `找到 ${result.total} 条${result.total > 20 ? '，显示前 20 条，请继续输入关键词缩小范围' : ''}` : '未找到匹配证券，可尝试完整代码核验添加'}
    </div>
    <ul id="security-results" className="search-results" role="listbox" aria-label="证券搜索结果" aria-busy={loading}>
      {result?.items.map(item => <li key={item.symbol} id={`search-${item.symbol}`} role="option" aria-selected={selected === item.symbol}
        className={selected === item.symbol ? 'selected' : ''} data-symbol={item.symbol} onMouseDown={() => setSelected(item.symbol)}>
        <div className="search-security"><strong>{item.name}</strong><span>{MARKET_NAMES[item.symbol.slice(0, 2) as SecurityMarket]} · {item.symbol}</span></div>
        <button disabled={Boolean(disabledReason(item.symbol)) || loading} onFocus={() => setSelected(item.symbol)} onClick={() => add(item.symbol)}
          aria-label={`${disabledReason(item.symbol) || '添加'} ${item.symbol}`}>{disabledReason(item.symbol) || '添加'}</button>
      </li>)}
    </ul>
    {query.trim() && !loading && !composing && exactCode && !result?.items.some(item => item.symbol === symbol) &&
      <div className="search-fallback"><span>使用完整代码 {symbol}</span><button disabled={Boolean(disabledReason(symbol))} onClick={() => add(symbol)}>
        {disabledReason(symbol) || '核验并添加'}</button></div>}
    <details className="directory-details">
      <summary>证券目录状态{refreshing ? ' · 正在更新' : directory?.markets.some(item => item.error) ? ' · 部分市场更新失败' : ''}</summary>
      <div className="directory-status" aria-label="证券目录状态" aria-live="polite">
        {(directory?.markets || []).map(item => <div key={item.market} className={item.error ? 'directory-market has-error' : 'directory-market'} data-market={item.market}>
          <strong>{MARKET_NAMES[item.market]}</strong>
          <span>{item.count ? `${item.count.toLocaleString()} 只` : '尚无目录'}{item.refreshing ? ' · 正在更新' : ''}</span>
          <small>{item.updatedAt ? `更新于 ${new Date(item.updatedAt).toLocaleString('zh-CN', { hour12: false })}` : '首次同步后可离线搜索'}</small>
          {item.error && <small className="search-error">{item.error}{item.count ? '；继续使用已有目录' : ''}</small>}
        </div>)}
      </div>
      <p className="muted search-coverage">AKShare 目录每日自动同步，可离线按代码、中英文名称和拼音首字母搜索。添加时由行情服务核验证券；名称覆盖因数据源而异，行情权限以富途为准。</p>
    </details>
  </div>;
}
