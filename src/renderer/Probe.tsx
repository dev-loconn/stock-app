import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_SYMBOLS, type ProbeBridge, type ProbeReport } from '../shared/probe';
import './probe.css';

declare global { interface Window { openDProbe: ProbeBridge } }
const labels = { passed: '通过', partial: '部分通过', failed: '未通过', pending: '待验证' };
const price = (value: number | undefined) => value === undefined ? '—' : String(value);

function App() {
  const [port, setPort] = useState('33333');
  const [ssl, setSsl] = useState(false);
  const [key, setKey] = useState('');
  const [symbols, setSymbols] = useState(DEFAULT_SYMBOLS.join(', '));
  const [report, setReport] = useState<ProbeReport | null>(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    const remove = window.openDProbe.onReport(setReport);
    void window.openDProbe.getReport().then(value => { if (value) setReport(value); });
    window.openDProbe.ready();
    return remove;
  }, []);

  const run = async () => {
    setError(''); setStarting(true);
    try {
      const result = await window.openDProbe.run({ host: '127.0.0.1', port: Number(port), ssl, key,
        symbols: symbols.split(/[,，\s]+/).filter(Boolean), observeMs: 15000 });
      if (!result.ok) setError(result.message || '验证未能启动');
      else setKey('');
    } catch { setError('无法启动验证，请重新打开程序'); }
    finally { setStarting(false); }
  };

  return <main>
    <header><div><p className="eyebrow">STOCK BAR / 接入验证</p><h1>连接本机 OpenD</h1>
      <p className="muted">验证 Electron 主进程中的官方 SDK、行情权限与报价推送。</p></div>
      <span className={`badge ${report?.outcome || 'pending'}`}>{report?.running ? '验证进行中' : labels[report?.outcome || 'pending']}</span>
    </header>
    <section className="panel">
      <div className="form-row">
        <label>本机 WebSocket 端口<input inputMode="numeric" value={port} onChange={e => setPort(e.target.value)} disabled={report?.running} /></label>
        <label className="grow">WebSocket 密钥<input type="password" autoComplete="off" spellCheck={false} value={key} onChange={e => setKey(e.target.value)} disabled={report?.running} placeholder="如 OpenD 已配置密钥，请在此输入" /></label>
        <label className="checkbox"><input type="checkbox" checked={ssl} onChange={e => setSsl(e.target.checked)} disabled={report?.running} />SSL</label>
      </div>
      <label>验证证券（最多 10 只，逗号分隔）<input value={symbols} onChange={e => setSymbols(e.target.value)} disabled={report?.running} /></label>
      <div className="actions"><button onClick={() => void run()} disabled={starting || report?.running}>连接并观察 15 秒</button>
        {report?.running && <button className="secondary" onClick={() => void window.openDProbe.cancel()}>停止验证</button>}
        <span className="muted">密钥仅在当前会话使用，不写入磁盘或报告。</span>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
    <section className="panel"><h2>验证步骤</h2>
      {!report && <p className="muted">请保持 OpenD 运行并已登录，在其设置中核对 WebSocket 端口和密钥。TCP 的 11111 端口不用于此验证。</p>}
      <ol>{report?.checks.map((check, index) => <li key={index}>
        <span className={`status ${check.status}`}>{labels[check.status]}</span><div><strong>{check.name}</strong><p>{check.detail}</p></div>
      </li>)}</ol>
    </section>
    <section className="panel"><h2>原始报价与推送</h2><p className="muted">价格列为源数据的常规价；扩展时段字段单独列出，不推断其时间或计算基准。</p>
      <div className="table-wrap"><table><thead><tr><th>证券 / 名称</th><th>订阅 / 市场状态</th><th>常规价 / 昨收</th><th>常规价源时间</th><th>盘前 / 盘后价</th><th>推送</th></tr></thead>
        <tbody>{(report?.symbols || []).map(item => <tr key={item.symbol}>
          <td><strong>{item.symbol}</strong><small>{item.name || '名称待验证'}</small></td>
          <td><span className={`status ${item.subscription}`}>{labels[item.subscription]}</span><small>{item.marketState || '时段未知'}</small>{item.error && <small className="error">{item.error}</small>}</td>
          <td>{price(item.quote?.price)}<small>昨收 {price(item.quote?.lastClose)}</small></td>
          <td>{item.quote?.sourceTime || '—'}<small>{item.quote?.sourceTimeZone || '源时间未知'}</small></td>
          <td>{price(item.quote?.preMarket?.price)} / {price(item.quote?.afterMarket?.price)}<small>扩展时段源时间未知</small></td>
          <td>{item.pushCount}<small>{item.distinctSourceTimes.length} 个源时间</small></td>
        </tr>)}</tbody></table></div>
      {report && <p className="runtime">Electron {report.runtime.electron || '—'} · Node {report.runtime.node} · futu-api {report.runtime.sdk} · {report.endpoint}</p>}
    </section>
    <footer>{(report?.notes || ['最小验证不展示模拟价格，不执行交易操作；首笔推送可能是 OpenD 缓存。']).map(note => <p key={note}>{note}</p>)}</footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);

