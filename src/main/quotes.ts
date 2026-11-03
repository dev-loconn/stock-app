import { OpenDClient, list, number, object, redact, string } from './sdk';
import { applyBasic, applyTrades, desiredSession, isExtendedSession, selectQuote, type QuoteBook } from './market';
import { normalizeSymbol, type Connection, type Preferences, type SecurityMarket, type StockRow, type StockState, type WatchItem } from '../shared/stock';

export const security = (symbol: string) => {
  const market = ({ HK: 1, US: 11, SH: 21, SZ: 22 } as Record<string, number>)[symbol.slice(0, 2)];
  if (!market) throw Error('当前行情服务不支持该证券市场');
  return { market, code: symbol.slice(3) };
};
function symbolOf(value: unknown): string | undefined {
  const valueObject = object(value);
  const market = ({ 1: 'HK', 11: 'US', 21: 'SH', 22: 'SZ' } as Record<number, string>)[Number(valueObject.market)];
  if (!market || typeof valueObject.code !== 'string') return undefined;
  return `${market}.${valueObject.code}`;
}
function safeError(error: unknown, key: string) { return redact(error instanceof Error ? error.message : String(error), key); }
export class QuoteService {
  private client?: OpenDClient;
  private controller?: AbortController;
  private generation = 0;
  private retry?: ReturnType<typeof setTimeout>;
  private poll?: ReturnType<typeof setInterval>;
  private emitTimer?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private running = false;
  private connection: Connection = 'disconnected';
  private message = '尚未连接 OpenD';
  private retryAt?: number;
  private key = '';
  private books = new Map<string, QuoteBook>();
  private rows = new Map<string, StockRow>();
  private tickerSubscriptions = new Map<string, number>();
  private basicSubscriptions = new Set<string>();
  private bmpSymbols = new Set<string>();
  private snapshotSymbols = new Set<string>();
  private serverEpoch?: number;
  private clockAt = 0;
  private serverVersion?: { serverVer?: number; serverBuildNo?: number };
  private preferences: Preferences;

  constructor(preferences: Preferences, private publish: () => void, private options = { pollMs: 15000, retryMs: [1000, 2000, 5000, 10000, 30000] }) {
    this.preferences = structuredClone(preferences); this.syncRows();
  }
  state(keySaved: boolean): StockState {
    for (const row of this.rows.values()) {
      const chosen = selectQuote(this.books.get(row.symbol)!, row.marketState, this.now());
      row.quote = chosen.quote;
      row.marketLabel = chosen.status;
      row.status = row.permission === 'denied' ? '无权限' : row.error ? '数据异常' : chosen.status + (this.snapshotSymbols.has(row.symbol) ? ' · 快照' : '');
    }
    return { connection: this.connection, message: this.message, retryAt: this.retryAt,
      preferences: structuredClone(this.preferences), keySaved, keyInSession: Boolean(this.key),
      rows: this.preferences.watchlist.map(item => structuredClone(this.rows.get(item.symbol)!)), updatedAt: Date.now() };
  }
  diagnostics() {
    return { server: this.serverVersion, basicSubscriptions: this.basicSubscriptions.size,
      extendedSubscriptions: this.tickerSubscriptions.size };
  }
  private now(): number | undefined { return this.serverEpoch ? this.serverEpoch + performance.now() - this.clockAt : undefined; }
  private emit() { if (!this.emitTimer) this.emitTimer = setTimeout(() => { this.emitTimer = undefined; this.publish(); }, 80); }
  private syncRows() {
    const keep = new Set(this.preferences.watchlist.map(item => item.symbol));
    for (const symbol of this.rows.keys()) if (!keep.has(symbol)) { this.rows.delete(symbol); this.books.delete(symbol); }
    for (const item of this.preferences.watchlist) {
      const previous = this.rows.get(item.symbol);
      this.rows.set(item.symbol, { ...item, marketLabel: '时段未知', status: '等待行情', permission: 'unknown', timeliness: 'unknown', pushCount: 0, ...previous, name: item.name, showInBar: item.showInBar });
      if (!this.books.has(item.symbol)) this.books.set(item.symbol, { symbol: item.symbol });
    }
  }
  configure(preferences: Preferences, key: string, connect = true): void {
    const reconnect = this.preferences.host !== preferences.host || this.preferences.port !== preferences.port
      || this.preferences.ssl !== preferences.ssl || this.key !== key
      || [...this.rows.keys()].sort().join() !== preferences.watchlist.map(item => item.symbol).sort().join();
    this.preferences = structuredClone(preferences); this.key = key; this.syncRows();
    if (connect && (!this.running || reconnect)) { this.running = true; this.attempt = 0; this.endSession(); void this.open(); }
    this.emit();
  }
  private endSession(): void {
    this.generation++;
    clearTimeout(this.retry); this.retry = undefined;
    this.retryAt = undefined;
    clearInterval(this.poll); this.poll = undefined;
    this.controller?.abort(); this.controller = undefined;
    this.client?.close(); this.client = undefined;
    this.tickerSubscriptions.clear();
    this.basicSubscriptions.clear();
    this.bmpSymbols.clear(); this.snapshotSymbols.clear();
  }
  stop(): void {
    this.running = false; this.endSession(); clearTimeout(this.emitTimer); this.emitTimer = undefined;
    this.connection = 'disconnected'; this.message = '已停止连接'; this.key = '';
  }
  reconnect(): void { if (this.running) { this.endSession(); this.attempt = 0; void this.open(); } }
  suspend(): void {
    if (!this.running) return;
    this.endSession(); this.retryAt = undefined;
    this.connection = 'disconnected'; this.message = '系统休眠，唤醒后自动恢复连接'; this.emit();
  }
  private fail(error: unknown, generation: number): void {
    if (!this.running || generation !== this.generation) return;
    this.message = safeError(error, this.key);
    this.endSession();
    const delay = this.options.retryMs[Math.min(this.attempt++, this.options.retryMs.length - 1)];
    this.connection = 'retrying'; this.retryAt = Date.now() + delay;
    this.retry = setTimeout(() => { this.retry = undefined; void this.open(); }, delay);
    this.emit();
  }
  private async open(): Promise<void> {
    if (!this.running) return;
    const generation = ++this.generation;
    const controller = new AbortController(); this.controller = controller;
    this.connection = 'connecting'; this.message = '正在连接本机 OpenD'; this.retryAt = undefined; this.emit();
    for (const row of this.rows.values()) { row.permission = 'unknown'; row.error = undefined; }
    const active = () => generation === this.generation && !controller.signal.aborted;
    try {
      const client = new OpenDClient(); this.client = client;
      await client.connect({ ...this.preferences, key: this.key }, controller.signal, response => {
        if (!active()) return;
        for (const value of list(object(object(response).s2c).basicQotList)) this.basic(value, true);
      }, () => this.fail(new Error('连接已断开，正在自动恢复'), generation), (_command, response) => {
        if (!active()) return;
        const payload = object(object(response).s2c); this.trades(payload.security, list(payload.tickerList));
      });
      await this.refresh(client, controller.signal, active);
      if (!active()) return;
      // Health checks must not wait behind optional rights, snapshots or ticker requests.
      let polling = false;
      let maintaining = true;
      let connectedAt: number | undefined;
      this.poll = setInterval(() => {
        if (polling || !active()) return;
        polling = true;
        void this.refresh(client, controller.signal, active).then(() => {
          if (!active()) return;
          // A brief handshake is not recovery. Reset backoff only after a healthy session.
          if (connectedAt !== undefined && Date.now() - connectedAt >= 15000) this.attempt = 0;
          if (!maintaining) {
            maintaining = true;
            void this.maintain(client, controller.signal, active)
              .catch(error => this.fail(error, generation)).finally(() => { maintaining = false; });
          }
        }).catch(error => this.fail(error, generation)).finally(() => { polling = false; });
      }, this.options.pollMs);
      try {
        const rights = await client.request('GetUserInfo', { flag: 6 }, controller.signal);
        if (!active()) return;
        for (const row of this.rows.values()) {
          const right = number(row.symbol.startsWith('HK.') ? rights.hkQotRight : row.symbol.startsWith('US.') ? rights.usQotRight : rights.cnQotRight);
          if (right === 5) row.permission = 'denied';
          if (right === 1) this.bmpSymbols.add(row.symbol);
        }
      } catch { /* Subscription responses remain the authority for each security. */ }
      await this.maintain(client, controller.signal, active);
      if (!active()) return;
      maintaining = false; connectedAt = Date.now();
      this.connection = 'connected'; this.message = '已连接';
      this.emit();
    } catch (error) { this.fail(error, generation); }
  }
  private async maintain(client: OpenDClient, signal: AbortSignal, active: () => boolean): Promise<void> {
    await Promise.all([...this.rows.values()].map(async row => {
      if (!active() || row.permission === 'denied' || this.snapshotSymbols.has(row.symbol)) return;
      if (this.basicSubscriptions.has(row.symbol) && (!row.error || row.error.startsWith('扩展时段'))) return;
      try {
        if (!this.basicSubscriptions.has(row.symbol)) {
          await client.request('Sub', { securityList: [security(row.symbol)], subTypeList: [1], isSubOrUnSub: true, isRegOrUnRegPush: true, isFirstPush: true }, signal);
          if (!active()) return;
          this.basicSubscriptions.add(row.symbol);
        }
        if (!active()) return;
        row.permission = 'available'; row.error = undefined;
        const quotes = await client.request('GetBasicQot', { securityList: [security(row.symbol)] }, signal);
        if (active()) for (const value of list(quotes.basicQotList)) this.basic(value, false);
      } catch (error) {
        if (active()) {
          row.error = safeError(error, this.key); row.permission = /权限|permission|right/i.test(row.error) ? 'denied' : row.permission;
          if (this.bmpSymbols.has(row.symbol)) this.snapshotSymbols.add(row.symbol);
        }
      }
    }));
    if (!active()) return;
    await this.snapshots(client, signal, active);
    await this.extended(client, signal, active);
    if (active()) this.emit();
  }
  private async refresh(client: OpenDClient, signal: AbortSignal, active: () => boolean): Promise<void> {
    const global = await client.request('GetGlobalState', { userID: 0 }, signal);
    if (!active()) return;
    if (global.qotLogined !== true) throw new Error('OpenD 行情服务器未登录，请在官方程序完成登录');
    this.serverVersion = { serverVer: number(global.serverVer), serverBuildNo: number(global.serverBuildNo) };
    const time = Number(String(global.time));
    if (Number.isFinite(time) && time > 0) { this.serverEpoch = time * 1000; this.clockAt = performance.now(); }
    for (const row of this.rows.values()) row.marketState = number(row.symbol.startsWith('HK.') ? global.marketHK : global.marketUS);
    if (this.rows.size) {
      try {
        const states = await client.request('GetMarketState', { securityList: [...this.rows.keys()].map(security) }, signal);
        if (!active()) return;
        for (const entry of list(states.marketInfoList)) {
          const value = object(entry); const row = this.rows.get(symbolOf(value.security) || '');
          if (row) {
            row.marketState = number(value.marketState);
            if (desiredSession(row.symbol, row.marketState) === 'regular' && row.error?.startsWith('扩展时段')) row.error = undefined;
          }
        }
      } catch { /* Global market states are still source-supplied; no local clock inference. */ }
    }
    if (active()) this.emit();
  }
  private async snapshots(client: OpenDClient, signal: AbortSignal, active: () => boolean): Promise<void> {
    if (!active() || !this.snapshotSymbols.size) return;
    try {
      const result = await client.request('GetSecuritySnapshot', { securityList: [...this.snapshotSymbols].map(security) }, signal);
      if (!active()) return;
      for (const value of list(result.snapshotList)) {
        const basic = object(object(value).basic); const symbol = symbolOf(basic.security);
        if (!symbol || !this.snapshotSymbols.has(symbol)) continue;
        this.basic({ ...basic, isSuspended: basic.isSuspend }, false);
        const row = this.rows.get(symbol)!; row.permission = 'available'; row.error = undefined;
      }
    } catch (error) {
      if (active()) for (const symbol of this.snapshotSymbols) this.rows.get(symbol)!.error = `快照暂不可用：${safeError(error, this.key)}`;
    }
    if (active()) this.emit();
  }
  private basic(value: unknown, pushed: boolean): void {
    const data = object(value); const symbol = symbolOf(data.security);
    if (!symbol || !this.books.has(symbol)) return;
    const row = this.rows.get(symbol)!;
    applyBasic(this.books.get(symbol)!, value, Date.now());
    if (pushed) row.pushCount++;
    this.emit();
  }
  private trades(value: unknown, trades: unknown[]): void {
    const symbol = symbolOf(value); if (!symbol || !this.books.has(symbol)) return;
    applyTrades(this.books.get(symbol)!, trades, this.rows.get(symbol)?.marketState, this.now(), Date.now()); this.emit();
  }
  private async extended(client: OpenDClient, signal: AbortSignal, active: () => boolean): Promise<void> {
    for (const row of this.rows.values()) {
      if (!active()) return;
      const session = desiredSession(row.symbol, row.marketState);
      if (row.permission === 'denied' || !row.symbol.startsWith('US.') || !isExtendedSession(session)) continue;
      try {
        // OpenD quote subscriptions require ALL for overnight ticks; OVERNIGHT is trade-only.
        const requestedSession = session === 'overnight' ? 3 : 2;
        const previousSession = this.tickerSubscriptions.get(row.symbol);
        if (previousSession !== requestedSession) {
          if (previousSession !== undefined) {
            await client.request('Sub', { securityList: [security(row.symbol)], subTypeList: [4], isSubOrUnSub: false,
              isRegOrUnRegPush: false, session: previousSession }, signal);
            if (!active()) return;
            this.tickerSubscriptions.delete(row.symbol);
          }
          await client.request('Sub', { securityList: [security(row.symbol)], subTypeList: [4], isSubOrUnSub: true,
            isRegOrUnRegPush: true, isFirstPush: true, extendedTime: true, session: requestedSession }, signal);
          if (!active()) return;
          this.tickerSubscriptions.set(row.symbol, requestedSession);
        }
        const ticks = await client.request('GetTicker', { security: security(row.symbol), maxRetNum: 20 }, signal);
        if (active()) { this.trades(ticks.security, list(ticks.tickerList)); if (row.error?.startsWith('扩展时段')) row.error = undefined; }
      } catch (error) { if (active()) { row.error = `扩展时段暂不可用：${safeError(error, this.key)}`; this.emit(); } }
    }
  }
  async directory(market: SecurityMarket): Promise<WatchItem[]> {
    if (!this.client || !this.controller || this.connection !== 'connected') throw Error('请先连接 OpenD，再加载证券目录');
    const client = this.client; const generation = this.generation; const signal = this.controller.signal;
    const items: WatchItem[] = [];
    for (const secType of [3, 4]) {
      const response = await client.request('GetStaticInfo', { market: security(`${market}.000001`).market, secType }, signal, 30000);
      if (client !== this.client || generation !== this.generation) throw Error('连接已变化，请重新刷新目录');
      if (!Array.isArray(response.staticInfoList) || !response.staticInfoList.length) throw Error('证券目录返回为空，请稍后重试');
      for (const value of response.staticInfoList) {
        const basic = object(object(value).basic); const symbol = symbolOf(basic.security);
        if (!symbol || !symbol.startsWith(market + '.') || Number(basic.secType) !== secType || basic.delisting === true) continue;
        const name = string(basic.name)?.trim();
        if (!name || /^(未知股票|未知证券|unknown stock|unknown security)$/i.test(name)) continue;
        try { items.push({ symbol: normalizeSymbol(symbol), name, securityType: secType }); } catch { /* Ignore unsupported code formats. */ }
      }
    }
    return items;
  }
  async lookup(value: unknown): Promise<WatchItem> {
    const symbol = normalizeSymbol(value);
    if (!this.client || !this.controller || this.connection !== 'connected') throw new Error('请先连接 OpenD，再核验证券代码');
    const client = this.client; const generation = this.generation;
    const response = await client.request('GetStaticInfo', { securityList: [security(symbol)] }, this.controller.signal);
    if (client !== this.client || generation !== this.generation) throw new Error('连接已变化，请重试');
    const basic = list(response.staticInfoList).map(value => object(object(value).basic)).find(item => symbolOf(item.security) === symbol);
    if (!basic || !string(basic.name)?.trim() || basic.delisting === true
      || /^(未知股票|未知证券|unknown stock|unknown security)$/i.test(string(basic.name)!.trim())) throw new Error('未找到有效证券，请检查市场和代码');
    if (![3, 4].includes(Number(basic.secType))) throw new Error('第一版仅支持股票和 ETF，不支持该证券类型');
    return { symbol, name: string(basic.name)!, securityType: Number(basic.secType) };
  }
}
