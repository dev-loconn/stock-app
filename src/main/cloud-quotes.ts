import { CloudError, cloudError, entries, obj, positive, type CloudRequest, type Json } from './cloud-api';
import type { CloudAuth } from './cloud-auth';
import type { CloudSocket } from './cloud-network';
import { applyCloudQuote, applyCloudTickers, cloudMarketState, type CloudPeriod } from './cloud-market';
import { desiredSession, isExtendedSession, selectQuote, type QuoteBook } from './market';
import { normalizeSymbol, type Preferences, type SecurityMarket, type StockState, type StockRow, type WatchItem } from '../shared/stock';

export class CloudQuoteService {
  private preferences: Preferences;
  private rows = new Map<string, StockRow>();
  private books = new Map<string, QuoteBook>();
  private payloads = new Map<string, Json>();
  private connection: StockState['connection'] = 'disconnected';
  private message = '请登录富途云端，无需安装 OpenD';
  private generation = 0;
  private running = false;
  private controller?: AbortController;
  private release?: () => void;
  private socket?: CloudSocket;
  private timer?: ReturnType<typeof setInterval>;
  private retry?: ReturnType<typeof setTimeout>;
  private retryAt?: number;
  private attempt = 0;
  private serverNow?: number;
  private clockAt = 0;
  private forceToken = false;
  private subscriptions = new Set<string>();
  private tickerSubscriptions = new Set<string>();
  private tickerBackfills = new Map<string, string>();
  private snapshots = new Set<string>();
  constructor(preferences: Preferences, private publish: () => void, private auth: Pick<CloudAuth, 'state' | 'token'>,
    private request: CloudRequest, private openSocket: () => Promise<{ socket: CloudSocket; release: () => void }>,
    private options = { pollMs: 30000, retryMs: [1000, 2000, 5000, 10000, 30000], refreshMs: 240000 }) {
    this.preferences = structuredClone(preferences); this.syncRows();
  }
  private now() { return this.serverNow ? this.serverNow + performance.now() - this.clockAt : undefined; }
  private syncRows() {
    const keep = new Set(this.preferences.watchlist.map(item => item.symbol));
    for (const symbol of this.rows.keys()) if (!keep.has(symbol)) { this.rows.delete(symbol); this.books.delete(symbol); this.payloads.delete(symbol); this.snapshots.delete(symbol); this.tickerBackfills.delete(symbol); }
    for (const item of this.preferences.watchlist) {
      this.rows.set(item.symbol, { ...item, marketLabel: '时段未知', permission: 'unknown', timeliness: 'unknown', status: '等待行情', pushCount: 0,
        ...this.rows.get(item.symbol), name: item.name, showInBar: item.showInBar });
      if (!this.books.has(item.symbol)) this.books.set(item.symbol, { symbol: item.symbol });
    }
  }
  state(keySaved: boolean): StockState {
    const cloud = this.auth.state();
    for (const row of this.rows.values()) {
      const selected = selectQuote(this.books.get(row.symbol)!, row.marketState, this.now());
      row.quote = selected.quote; row.marketLabel = selected.status;
      row.status = cloud.status === 'signedOut' ? '请登录富途' : row.error ? '云端行情异常'
        : row.quote ? selected.status + (this.snapshots.has(row.symbol) ? ' · 快照' : '') : '等待行情';
    }
    return { preferences: structuredClone(this.preferences), connection: this.connection, message: this.message,
      retryAt: this.retryAt, rows: this.preferences.watchlist.map(item => structuredClone(this.rows.get(item.symbol)!)),
      keySaved, keyInSession: false, updatedAt: Date.now(), cloud };
  }
  diagnostics() { return { server: undefined, basicSubscriptions: this.subscriptions.size, extendedSubscriptions: this.tickerSubscriptions.size }; }
  configure(preferences: Preferences, _key: string, connect = true) {
    const changed = this.preferences.watchlist.map(item => item.symbol).sort().join() !== preferences.watchlist.map(item => item.symbol).sort().join();
    this.preferences = structuredClone(preferences); this.syncRows();
    if (connect && (!this.running || changed)) { this.running = true; this.reconnect(); }
    this.publish();
  }
  private end() {
    this.generation++; this.controller?.abort(); this.controller = undefined;
    clearInterval(this.timer); clearTimeout(this.retry); this.retryAt = undefined;
    if (this.socket?.readyState === 1 && this.subscriptions.size) {
      this.socket.send(JSON.stringify({ id: 'unsubscribe', action: 'unsubscribe', quote: [...this.subscriptions], ticker: [...this.tickerSubscriptions] }));
    }
    this.release?.(); this.release = undefined; this.socket = undefined; this.subscriptions.clear(); this.tickerSubscriptions.clear(); this.tickerBackfills.clear();
  }
  stop() { this.running = false; this.end(); this.connection = 'disconnected'; this.message = '已停止连接'; }
  suspend() { this.end(); this.connection = 'disconnected'; this.message = '系统休眠，唤醒后自动恢复云端连接'; this.publish(); }
  reconnect() { if (!this.running) return; this.end(); this.attempt = 0; void this.open(); }
  private fail(error: unknown, generation: number) {
    if (!this.running || generation !== this.generation) return;
    for (const row of this.rows.values()) row.error = cloudError(error);
    this.end(); this.message = cloudError(error);
    if (error instanceof CloudError && error.loginRequired) { this.connection = 'disconnected'; this.publish(); return; }
    const delay = this.options.retryMs[Math.min(this.attempt++, this.options.retryMs.length - 1)];
    this.connection = 'retrying'; this.retryAt = Date.now() + delay;
    this.retry = setTimeout(() => { void this.open(); }, delay); this.publish();
  }
  private apply(symbol: string, data: Json, pushed: boolean, snapshot = false) {
    const row = this.rows.get(symbol); if (!row) return;
    const old = this.payloads.get(symbol) || {};
    const nextTime = positive(data.data_time_ms) || positive(data.data_time);
    const oldTime = positive(old.data_time_ms) || positive(old.data_time);
    // Regular and extended quotes have independent source clocks. An older
    // regular anchor must not discard a fresh overnight/pre/after update.
    const merged = nextTime && oldTime && nextTime < oldTime ? { ...old } : { ...old, ...data };
    for (const key of ['pre_market', 'after_market', 'overnight']) {
      const next = obj(data[key]); const previous = obj(old[key]);
      const nextSource = positive(next.data_time_ms) || positive(next.data_time);
      const previousSource = positive(previous.data_time_ms) || positive(previous.data_time);
      if (nextSource && (!previousSource || nextSource >= previousSource)) merged[key] = data[key];
      else if (previousSource) merged[key] = old[key];
    }
    if (nextTime && (!oldTime || nextTime >= oldTime)) merged.data_time_ms = nextTime;
    this.payloads.set(symbol, merged);
    if (!nextTime || !oldTime || nextTime >= oldTime) { if (snapshot) this.snapshots.add(symbol); else this.snapshots.delete(symbol); }
    applyCloudQuote(this.books.get(symbol)!, merged, row.marketState, this.now(), pushed);
    row.permission = 'available'; row.error = undefined; if (pushed) row.pushCount++;
  }
  private syncTickers() {
    if (this.socket?.readyState !== 1) return;
    const wanted = new Set([...this.rows.values()].filter(row => row.symbol.startsWith('US.') && isExtendedSession(desiredSession(row.symbol, row.marketState))).map(row => row.symbol));
    const removed = [...this.tickerSubscriptions].filter(symbol => !wanted.has(symbol));
    const added = [...wanted].filter(symbol => !this.tickerSubscriptions.has(symbol));
    if (removed.length) this.socket.send(JSON.stringify({ id: 'ticker-unsubscribe', action: 'unsubscribe', ticker: removed }));
    if (added.length) this.socket.send(JSON.stringify({ id: 'ticker-subscribe', action: 'subscribe', ticker: added }));
    this.tickerSubscriptions = wanted;
  }
  private async extended(token: string, signal: AbortSignal, active: () => boolean) {
    for (const row of this.rows.values()) {
      if (!row.symbol.startsWith('US.') || desiredSession(row.symbol, row.marketState) === 'regular') continue;
      const session = desiredSession(row.symbol, row.marketState);
      const period: CloudPeriod = session === 'overnight' || [14, 34].includes(row.marketState ?? -1) ? 'OVERNIGHT' : [8, 9].includes(row.marketState ?? -1) ? 'BEFORE' : 'AFTER';
      const key = `${row.marketState}:${this.books.get(row.symbol)?.basic?.epoch}`;
      const live = isExtendedSession(session);
      if (!live && this.tickerBackfills.get(row.symbol) === key) continue;
      try {
        const response = await this.request(`/api/v1.0/quote/${row.symbol}/rt-ticker?num=100&period=${period}`, { token, signal });
        if (!active()) return;
        applyCloudTickers(this.books.get(row.symbol)!, obj(response.data), row.marketState, this.now(), period);
        this.tickerBackfills.set(row.symbol, key);
        if (row.error?.startsWith('扩展时段')) row.error = undefined;
      } catch (error) {
        if (!active()) return;
        if (error instanceof CloudError && error.loginRequired) throw error;
        row.error = '扩展时段行情暂不可用：' + cloudError(error);
      }
    }
  }
  private async poll(signal: AbortSignal, active: () => boolean) {
    const token = await this.auth.token(); if (!active()) return;
    const time = await this.request('/api/v1.0/server-time', { signal }); if (!active()) return;
    const timestamp = Number(time.server_time_ms);
    if (Number.isFinite(timestamp) && timestamp > 0) { this.serverNow = timestamp; this.clockAt = performance.now(); }
    const symbols = this.preferences.watchlist.map(item => item.symbol);
    if (symbols.length) {
      const states = await this.request('/api/v1.0/quote/market-state', { token, signal, body: { code_list: symbols } }); if (!active()) return;
      for (const value of entries(obj(states.data).market_state_list)) {
        const row = this.rows.get(String(value.code)); if (row) row.marketState = cloudMarketState(value.market_state);
      }
      this.syncTickers();
      const quotes = await this.request('/api/v1.0/quote/stock-quote', { token, signal, body: { code_list: symbols } }); if (!active()) return;
      const returned = new Set<string>();
      for (const value of entries(obj(quotes.data).quote_list)) { const symbol = String(value.code); returned.add(symbol); this.apply(symbol, value, false); }
      const missing = symbols.filter(symbol => !returned.has(symbol));
      if (missing.length) {
        let snapshotError: string | undefined;
        try {
          const response = await this.request('/api/v1.0/quote/snapshot', { token, signal, body: { code_list: missing } });
          if (!active()) return;
          for (const value of entries(obj(response.data).snapshot_list)) {
            const symbol = String(value.code);
            if (!missing.includes(symbol) || !positive(value.last_price)) continue;
            this.apply(symbol, { ...value, data_time_ms: positive(value.update_time) }, false, true); returned.add(symbol);
          }
        } catch (error) {
          if (error instanceof CloudError && error.loginRequired) throw error;
          snapshotError = cloudError(error);
        }
        if (!active()) return;
        for (const symbol of missing) if (!returned.has(symbol)) this.rows.get(symbol)!.error = snapshotError || '未返回报价或快照，请检查证券和行情权限';
      }
      await this.extended(token, signal, active); if (!active()) return;
    }
    this.publish();
  }
  private async open() {
    if (!this.running) return;
    if (this.auth.state().status !== 'authorized') { this.connection = 'disconnected'; this.message = '请登录富途云端，无需安装 OpenD'; this.publish(); return; }
    const generation = ++this.generation; const controller = new AbortController(); this.controller = controller;
    const active = () => this.running && generation === this.generation && !controller.signal.aborted;
    this.connection = 'connecting'; this.message = '正在连接富途云端'; this.retryAt = undefined; this.publish();
    try {
      const forced = this.forceToken; this.forceToken = false;
      const token = await this.auth.token(forced); if (!active()) return;
      const transport = await this.openSocket(); if (!active()) { transport.release(); return; }
      this.socket = transport.socket; this.release = transport.release;
      const ws = transport.socket;
      let refreshPending = false; let healthyAt = 0;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new CloudError('云端鉴权超时，正在重试')), 15000);
        const abort = () => { clearTimeout(timeout); reject(new CloudError('连接已取消')); };
        controller.signal.addEventListener('abort', abort, { once: true });
        const authenticated = () => { clearTimeout(timeout); controller.signal.removeEventListener('abort', abort); resolve(); };
        ws.addEventListener('open', () => { if (active()) ws.send(JSON.stringify({ id: 'auth', action: 'auth', data: { auth_type: 'oauth2', authorization: `Bearer ${token}` } })); });
        ws.addEventListener('message', event => {
          if (!active()) return;
          let data: Json; try { data = obj(JSON.parse(String(event.data))); } catch { this.fail(new CloudError('云端消息格式异常'), generation); return; }
          if (typeof data.code === 'number' && data.code !== 0) {
            const invalid = data.code === 4002;
            if (!invalid && String(data.id).startsWith('ticker-')) {
              for (const symbol of this.tickerSubscriptions) this.rows.get(symbol)!.error = `扩展时段订阅失败（${data.code}），请检查行情权限或额度`;
              this.tickerSubscriptions.clear(); this.publish(); return;
            }
            if (invalid && !forced) this.forceToken = true;
            this.fail(new CloudError(invalid ? '云端授权需更新' : `云端订阅失败（${data.code}），请检查行情权限、数量或额度`, data.code, invalid && forced), generation); return;
          }
          if (data.session_id !== undefined) { authenticated(); refreshPending = false; healthyAt = Date.now(); }
          if (data.type === 'QUOTE' && typeof data.symbol === 'string') { this.apply(data.symbol, obj(data.data), true); this.publish(); }
          if (data.type === 'TICKER' && typeof data.symbol === 'string') {
            const row = this.rows.get(data.symbol); const book = this.books.get(data.symbol);
            if (row && book) { applyCloudTickers(book, obj(data.data), row.marketState, this.now()); row.pushCount++; this.publish(); }
          }
          if (data.type === 'MARKET_STATE') {
            for (const value of entries(obj(data.data).market_state_list)) { const row = this.rows.get(String(value.code)); if (row) row.marketState = cloudMarketState(value.market_state); }
            this.syncTickers();
            this.publish();
          }
        });
        ws.addEventListener('error', () => { clearTimeout(timeout); reject(new CloudError('云端连接失败，请检查网络或代理')); this.fail(new CloudError('云端连接失败，请检查网络或代理'), generation); });
        ws.addEventListener('close', () => { clearTimeout(timeout); reject(new CloudError('云端连接已断开')); this.fail(new CloudError('云端连接已断开，正在恢复'), generation); });
      });
      if (!active()) return;
      const symbols = this.preferences.watchlist.map(item => item.symbol);
      if (symbols.length) { ws.send(JSON.stringify({ id: 'subscribe', action: 'subscribe', quote: symbols })); for (const symbol of symbols) this.subscriptions.add(symbol); }
      await this.poll(controller.signal, active); if (!active()) return;
      this.connection = 'connected'; this.message = '已连接富途云端'; this.publish();
      let polling = false; let lastRefresh = Date.now();
      this.timer = setInterval(() => {
        if (!active() || polling) return; polling = true;
        void (async () => {
          if (refreshPending && Date.now() - lastRefresh > 20000) throw new CloudError('云端连接保活超时');
          if (Date.now() - lastRefresh >= this.options.refreshMs) {
            const updated = await this.auth.token(true); if (!active()) return;
            ws.send(JSON.stringify({ id: 'refresh', action: 'refresh', data: { authorization: `Bearer ${updated}` } }));
            if (symbols.length) ws.send(JSON.stringify({ id: 'subscribe', action: 'subscribe', quote: symbols }));
            this.tickerSubscriptions.clear(); this.syncTickers();
            lastRefresh = Date.now(); refreshPending = true;
          }
          await this.poll(controller.signal, active);
          if (active() && Date.now() - healthyAt >= 15000) this.attempt = 0;
        })().catch(error => this.fail(error, generation)).finally(() => { polling = false; });
      }, this.options.pollMs);
    } catch (error) { this.fail(error, generation); }
  }
  async directory(_market: SecurityMarket): Promise<WatchItem[]> {
    throw new CloudError('云端暂不提供全市场目录下载；可输入完整代码核验添加，已有目录仍可搜索');
  }
  async lookup(value: unknown): Promise<WatchItem> {
    const symbol = normalizeSymbol(value); const generation = this.generation;
    if (this.connection !== 'connected' || !this.controller) throw new CloudError('请先登录并连接富途云端');
    const signal = this.controller.signal;
    const token = await this.auth.token();
    const response = await this.request('/api/v1.0/quote/stock-basicinfo', { token, signal, body: { code_list: [symbol] } });
    if (generation !== this.generation) throw new CloudError('连接方式已变化，请重试');
    const basic = entries(obj(response.data).basic_list).find(item => item.code === symbol);
    const name = basic && (basic.sc_name || basic.name || basic.tc_name);
    if (!basic || typeof name !== 'string' || !name.trim() || /DELIST/i.test(String(basic.state))) throw new CloudError('未找到有效证券，请核对完整代码');
    if (!['STOCK', 'ETF'].includes(String(basic.stock_type))) throw new CloudError('仅支持股票和 ETF');
    return { symbol, name: name.trim().slice(0, 100), securityType: basic.stock_type === 'ETF' ? 4 : 3 };
  }
}
