import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { BAR_BRAND_WIDTH, BAR_TOOLS_WIDTH, BAR_CHROME_WIDTH, DEFAULT_PREFERENCES, barItems, formatChange, formatPrice, pageSize,
  type StockBridge, type StockRow, type StockState, type WatchItem } from '../shared/stock';
import './stock.css';
import { SecuritySearchPanel } from './SecuritySearch';
import { Watchlist } from './Watchlist';
import { panelMetrics } from '../shared/panel-layout';
import { ShortcutSettings } from './ShortcutSettings';

declare global { interface Window { stockBar: StockBridge } }
function useStock() {
  const [state, setState] = useState<StockState>();
  useEffect(() => {
    const remove = window.stockBar.onState(setState);
    void window.stockBar.get().then(setState); window.stockBar.ready();
    return remove;
  }, []);
  return state;
}
const connectionText = (state?: StockState) => ({ disconnected: '断线', connecting: '连接中', connected: '已连接', retrying: '重连中' }[state?.connection || 'disconnected']);
function color(value?: number) { return value === undefined || Math.abs(value) < 0.005 ? 'flat' : value > 0 ? 'up' : 'down'; }
function quoteStatus(row: StockRow) {
  return `${row.status}${row.timeliness === 'delayed' ? ' · 延迟' : ''}`;
}
function Bar({ state }: { state?: StockState }) {
  const [width, setWidth] = useState(innerWidth);
  const [pagination, setPagination] = useState({ key: '', page: 0 });
  const [overviewOpen, setOverviewOpen] = useState(false);
  useEffect(() => window.stockBar.onOverview(setOverviewOpen), []);
  const wheelAt = useRef(0);
  useEffect(() => { const resize = () => setWidth(innerWidth); addEventListener('resize', resize); return () => removeEventListener('resize', resize); }, []);
  const preferences = state?.preferences || DEFAULT_PREFERENCES;
  const selected = new Set(barItems(preferences.watchlist).map(item => item.symbol));
  const rows = state?.rows.filter(row => selected.has(row.symbol)) || [];
  const count = pageSize(width, preferences.securityWidth, preferences.barPageSize);
  const pages = Math.max(1, Math.ceil(rows.length / count));
  const pageKey = JSON.stringify([preferences.barPageSize, preferences.watchlist.map(item => [item.symbol, item.showInBar !== false])]);
  const current = Math.min(pagination.key === pageKey ? pagination.page : 0, pages - 1);
  useEffect(() => {
    setPagination(value => value.key !== pageKey ? { key: pageKey, page: 0 }
      : value.page >= pages ? { ...value, page: pages - 1 } : value);
  }, [pageKey, pages]);
  useEffect(() => window.stockBar.onPage(direction => {
    if (pages < 2) return;
    setPagination(value => ({ key: pageKey, page: ((value.key === pageKey ? Math.min(value.page, pages - 1) : 0) + direction + pages) % pages }));
  }), [pageKey, pages]);
  return <div className="stock-bar" style={{ '--font-size': `${preferences.fontSize}px`, '--security-width': `${Math.max(1, Math.min(preferences.securityWidth, width - BAR_CHROME_WIDTH))}px`,
    '--brand-width': `${BAR_BRAND_WIDTH}px`, '--tools-width': `${BAR_TOOLS_WIDTH}px` } as CSSProperties}
    onContextMenu={event => { event.preventDefault(); window.stockBar.menu(); }}
    onWheel={event => {
      if (Date.now() - wheelAt.current < 160 || pages < 2) return;
      wheelAt.current = Date.now();
      setPagination({ key: pageKey, page: (current + (event.deltaY > 0 ? 1 : -1) + pages) % pages });
    }}>
    <div className={`bar-brand ${state?.connection === 'connected' ? 'online' : 'offline'}`} title={`${connectionText(state)}${state?.message ? `：${state.message}` : ''}`} aria-label={`行情连接：${connectionText(state)}`}>
      <span className="grip" aria-label="拖动悬浮条">⠿</span><span className={`connection-dot ${state?.connection || 'disconnected'}`} />
      <span className="connection-word" role="status">{connectionText(state)}</span></div>
    <div className="bar-quotes">
      {!rows.length && <button className="empty-bar" onClick={() => window.stockBar.openSettings()}>{preferences.watchlist.length ? '请选择展示证券' : '添加自选证券，开始查看行情'}</button>}
      {rows.slice(current * count, (current + 1) * count).map(row => <div className="quote-tile" key={row.symbol}>
        <div className="quote-line"><span className="stock-name">{row.name}</span><strong className={color(row.quote?.changePercent)}>{formatPrice(row.quote)}</strong></div>
        <div className="quote-line subline"><span className="market-tag" title={quoteStatus(row)}>{quoteStatus(row)}</span>
          <span className={color(row.quote?.changePercent)}>{formatChange(row.quote?.changePercent)}</span></div>
      </div>)}
    </div>
    <div className="bar-tools"><span className="page-number">{current + 1}/{pages}</span><div className="bar-tool-buttons">
      <button className="overview-toggle" aria-label={overviewOpen ? '收起行情面板' : '展开行情面板'} aria-expanded={overviewOpen}
        title={overviewOpen ? '收起行情面板' : '查看行情'} onClick={() => window.stockBar.toggleOverview()}><span>{overviewOpen ? '▴' : '▾'}</span></button>
      <button aria-label="打开设置" title="设置与自选" onClick={() => window.stockBar.openSettings()}>⚙</button></div></div>
  </div>;
}

function Overview({ state }: { state?: StockState }) {
  const rows = state?.rows || [];
  const scroll = useRef<HTMLDivElement>(null);
  const fontSize = state?.preferences.fontSize || DEFAULT_PREFERENCES.fontSize;
  const metrics = panelMetrics(fontSize);
  useEffect(() => window.stockBar.onOverview(open => {
    document.body.inert = !open;
    if (open && scroll.current) scroll.current.scrollTop = 0;
  }), []);
  const label = connectionText(state);
  const detail = state?.message?.startsWith(label) ? state.message.slice(label.length).replace(/^[\s：:·]+/, '') : state?.message;
  return <main className="overview-page" aria-label="全部自选行情" style={{ '--font-size': `${fontSize}px`, '--panel-header': `${metrics.header}px`, '--panel-row': `${metrics.row}px` } as CSSProperties}>
    <header className="overview-header"><span className="overview-count">自选 <strong>{rows.length}</strong></span>
      <div className="overview-connection" role="status" title={[label, detail].filter(Boolean).join('：')}><span className={`connection-dot ${state?.connection || 'disconnected'}`} /><strong>{label}</strong></div>
      <button onClick={() => window.stockBar.openSettings()}>管理自选</button></header>
    {!state ? <div className="overview-empty">正在加载自选行情…</div> : !rows.length ? <div className="overview-empty"><p>尚未添加自选证券</p>
      <button onClick={() => window.stockBar.openSettings()}>添加自选证券</button></div> : <div className="overview-table-scroll" ref={scroll} tabIndex={0} aria-label="全部自选行情列表">
      <table className="overview-table" aria-label="自选证券、最新价与涨跌幅">
        <tbody>{rows.map(row => <tr key={row.symbol} data-symbol={row.symbol}>
          <th scope="row"><span className="overview-name">{row.name}</span><span className="overview-meta"><span className="overview-symbol">{row.symbol}</span>
            <span className={`overview-status ${row.permission === 'denied' || row.error ? 'has-error' : ''}`}>{quoteStatus(row)}</span></span></th>
          <td className={`overview-price ${color(row.quote?.changePercent)}`} aria-label={`最新价 ${formatPrice(row.quote)}`}>{formatPrice(row.quote)}</td>
          <td className={`overview-change ${color(row.quote?.changePercent)}`} aria-label={`涨跌幅 ${formatChange(row.quote?.changePercent)}`}>{formatChange(row.quote?.changePercent)}</td>
        </tr>)}</tbody></table>
    </div>}
  </main>;
}

function Settings({ state }: { state?: StockState }) {
  const [host, setHost] = useState('127.0.0.1'); const [port, setPort] = useState('33333');
  const [ssl, setSsl] = useState(false); const [key, setKey] = useState(''); const [remember, setRemember] = useState(false);
  const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => window.stockBar.onNotice(setMessage), []);
  const [securityWidth, setSecurityWidth] = useState(DEFAULT_PREFERENCES.securityWidth); const [fontSize, setFontSize] = useState(14); const [opacity, setOpacity] = useState(100); const [autoStart, setAutoStart] = useState(false);
  const [barPageSize, setBarPageSize] = useState(DEFAULT_PREFERENCES.barPageSize);
  const loaded = useRef(false);
  useEffect(() => {
    if (!state || loaded.current) return;
    loaded.current = true;
    const preferences = state.preferences; setHost(preferences.host); setPort(String(preferences.port)); setSsl(preferences.ssl); setRemember(state.keySaved);
    setSecurityWidth(preferences.securityWidth); setFontSize(preferences.fontSize); setOpacity(Math.round(preferences.opacity * 100)); setAutoStart(preferences.autoStart);
    setBarPageSize(preferences.barPageSize);
  }, [state]);
  const task = async (operation: () => Promise<void>) => { setBusy(true); setMessage(''); try { await operation(); } catch (error) { setMessage(error instanceof Error ? error.message : '操作失败'); } finally { setBusy(false); } };
  const saveList = async (items: WatchItem[]) => { const result = await window.stockBar.setWatchlist(items); if (!result.ok) throw new Error(result.message); };
  const list = state?.preferences.watchlist || [];
  return <main className="settings-page"><header><div><p className="eyebrow">STOCK BAR</p><h1>设置与自选</h1></div><div className="settings-header-actions"><span className={`state-pill ${state?.connection}`}>{connectionText(state)}</span>
      <button className="overview-entry" onClick={() => window.stockBar.openOverview()}>查看行情</button></div></header>
    <p className="connection-detail" role="status">{state?.message || '加载设置…'}</p>
    {state?.settingsWarning && <p className="search-error" role="alert">{state.settingsWarning}</p>}
    <section><h2>行情连接</h2>
      <label>连接方式<select aria-label="连接方式" value={state?.preferences.connectionMode || 'cloud'} disabled={busy || !state} onChange={event => void task(async () => {
        const result = await window.stockBar.setConnectionMode(event.target.value as 'cloud' | 'opend');
        if (!result.ok) throw Error(result.message); setMessage('连接方式已保存');
      })}><option value="cloud">富途云端（默认，无需 OpenD）</option><option value="opend">本地 OpenD（备用）</option></select></label>
      {state?.preferences.connectionMode !== 'opend' ? <div className="cloud-connection">
        <p>{state?.cloud?.message || '使用富途官方网页登录，无需安装 OpenD'}</p>
        <p className="muted">在系统浏览器登录并仅授权行情读取。使用 Windows 系统保护记住授权后，下次启动自动连接。</p>
        <div className="setting-actions"><button disabled={busy || !state} onClick={() => void task(async () => {
          const result = await window.stockBar.loginCloud(); if (!result.ok) throw Error(result.message); setMessage(result.message || '已授权，正在连接');
        })}>{state?.cloud?.status === 'authorizing' ? '等待浏览器授权…' : state?.cloud?.status === 'authorized' ? '重新授权' : '登录富途'}</button>
          {state?.cloud?.status === 'authorizing' && <button onClick={() => void window.stockBar.cancelCloudLogin()}>取消登录</button>}
          {state?.cloud?.status === 'authorized' && <button disabled={busy} onClick={() => void task(async () => {
            const result = await window.stockBar.logoutCloud(); if (!result.ok) throw Error(result.message); setMessage('已退出云端登录');
          })}>退出云端登录</button>}</div>
      </div> : <><div className="settings-grid"><label>本机地址<select value={host} onChange={event => setHost(event.target.value)}><option>127.0.0.1</option><option>localhost</option></select></label>
      <label>WebSocket 端口<input value={port} inputMode="numeric" onChange={event => setPort(event.target.value)} /></label>
      <label className="wide">WebSocket 密钥<input type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} placeholder={state?.keyInSession ? '留空保留当前密钥' : '只在本地输入，无需发送到聊天'} /></label></div>
      <div className="setting-checks"><label><input type="checkbox" checked={ssl} onChange={event => setSsl(event.target.checked)} />SSL</label>
        <label><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} />使用 Windows 系统保护记住密钥</label></div>
      <div className="setting-actions"><button disabled={busy || !state} onClick={() => void task(async () => {
        const result = await window.stockBar.connect({ host, port: Number(port), ssl, key, rememberKey: remember });
        if (!result.ok) throw new Error(result.message); setKey(''); setMessage('已应用连接设置，正在连接行情服务');
      })}>应用并连接</button><span className="muted">密钥不会返回到页面或写入明文文件。</span></div></>}
    </section>
    <section><div className="section-heading"><h2>自选证券</h2><span className="muted watchlist-count">共 {list.length} 只，悬浮条展示 {barItems(list).length} 只</span></div>
      <Watchlist items={list} busy={busy} onChange={items => void task(async () => {
        await saveList(items); setMessage('自选列表已保存');
      })} />
    </section>
    <section><h2>添加证券</h2>
      <SecuritySearchPanel state={state} busy={busy} onAdd={symbol => task(async () => {
        const result = await window.stockBar.add(symbol); if (!result.ok) throw Error(result.message); setMessage(result.message || '自选已保存');
      })} />
    </section>
    <section><h2>悬浮条外观</h2><div className="settings-grid"><label>单只证券宽度（逻辑像素）<input aria-label="单只证券宽度" type="number" min={1} step={1} value={securityWidth || ''} onChange={event => setSecurityWidth(Number(event.target.value))} /></label>
      <label>悬浮条每页最多显示<input aria-label="悬浮条每页最多显示" type="number" min={1} step={1} value={barPageSize || ''} onChange={event => setBarPageSize(Number(event.target.value))} /></label>
      <label>字号<input type="number" min={12} max={20} value={fontSize} onChange={event => setFontSize(Number(event.target.value))} /></label><label>透明度 %<input type="number" min={40} max={100} value={opacity} onChange={event => setOpacity(Number(event.target.value))} /></label></div>
      <p className="muted">仅展示勾选的证券，更多证券可用滚轮翻页。屏幕空间不足时自动减少每页数量；所有证券使用相同宽度，末页留空。</p>
      <label className="setting-checks"><input type="checkbox" checked={autoStart} onChange={event => setAutoStart(event.target.checked)} />开机自启（默认关闭）</label>
      <button disabled={busy} onClick={() => void task(async () => { const result = await window.stockBar.saveAppearance({ securityWidth, barPageSize, fontSize, opacity: opacity / 100, autoStart }); if (!result.ok) throw new Error(result.message); setMessage('外观已保存'); })}>保存外观</button>
    </section>
    <ShortcutSettings state={state} />
    {message && <p className="operation-message" role="status">{message}</p>}
    <footer>右键悬浮条可隐藏或退出，托盘图标可恢复。隐藏后继续接收行情。</footer>
  </main>;
}

export function StockApp() {
  const state = useStock();
  const view = new URLSearchParams(location.search).get('view') || 'bar';
  useEffect(() => { document.body.className = `view-${view}`; document.title = view === 'settings' ? '行情悬浮条 · 设置与自选' : view === 'overview' ? '全部自选行情' : '股票行情悬浮条'; }, [view]);
  if (view === 'settings') return <Settings state={state} />;
  if (view === 'overview') return <Overview state={state} />;
  return <Bar state={state} />;
}
