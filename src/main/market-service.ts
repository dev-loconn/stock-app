import { QuoteService } from './quotes';
import { CloudQuoteService } from './cloud-quotes';
import type { CloudAuth } from './cloud-auth';
import type { CloudRequest } from './cloud-api';
import type { CloudSocket } from './cloud-network';
import type { Preferences, SecurityMarket } from '../shared/stock';

export type QuoteProvider = Pick<QuoteService, 'state' | 'configure' | 'stop' | 'reconnect' | 'suspend' | 'directory' | 'lookup' | 'diagnostics'>;
export class MarketService implements QuoteProvider {
  private provider: QuoteProvider;
  private mode: Preferences['connectionMode'];
  constructor(preferences: Preferences, private publish: () => void, private auth: CloudAuth,
    private request: CloudRequest, private socket: () => Promise<{ socket: CloudSocket; release: () => void }>) {
    this.mode = preferences.connectionMode; this.provider = this.create(preferences);
  }
  private create(preferences: Preferences): QuoteProvider { return preferences.connectionMode === 'opend'
    ? new QuoteService(preferences, this.publish) : new CloudQuoteService(preferences, this.publish, this.auth, this.request, this.socket); }
  configure(preferences: Preferences, key: string, connect = true) {
    if (preferences.connectionMode === 'opend' && preferences.watchlist.some(item => item.symbol.startsWith('BJ.'))) throw Error('北交所行情请使用富途云端连接');
    if (preferences.connectionMode !== this.mode) { this.provider.stop(); this.mode = preferences.connectionMode; this.provider = this.create(preferences); }
    this.provider.configure(preferences, key, connect);
  }
  state(keySaved: boolean) { return { ...this.provider.state(keySaved), cloud: this.auth.state() }; }
  reset(preferences: Preferences, key: string) { this.provider.stop(); this.mode = preferences.connectionMode; this.provider = this.create(preferences); this.provider.configure(preferences, key); }
  stop() { this.provider.stop(); }
  suspend() { this.provider.suspend(); }
  reconnect() { this.provider.reconnect(); }
  diagnostics() { return this.provider.diagnostics(); }
  directory(market: SecurityMarket) { return this.provider.directory(market); }
  lookup(value: unknown) { return this.provider.lookup(value); }
}
