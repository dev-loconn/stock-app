import { DEFAULT_SHORTCUTS, type ShortcutBindings, type ShortcutStatuses, type ShortcutCapture } from './shortcuts';
export type Session = 'regular' | 'pre' | 'after' | 'overnight';
export type Connection = 'disconnected' | 'connecting' | 'connected' | 'retrying';
export type ConnectionMode = 'cloud' | 'opend';
export interface CloudLoginState { status: 'signedOut' | 'authorizing' | 'authorized'; remembered: boolean; message: string }
export interface WatchItem { symbol: string; name: string; securityType: number; aliases?: string[]; showInBar?: boolean }
export type SecurityMarket = 'HK' | 'US' | 'SH' | 'SZ' | 'BJ';
export type SearchMarket = SecurityMarket | 'CN' | 'all';
export const SECURITY_MARKETS: SecurityMarket[] = ['HK', 'US', 'SH', 'SZ', 'BJ'];
export const MARKET_NAMES: Record<SecurityMarket, string> = { HK: '港股', US: '美股', SH: '沪股', SZ: '深股', BJ: '北交所' };
export function matchesMarket(current: SecurityMarket, filter: unknown): boolean {
  return filter === 'all' || current === filter || filter === 'CN' && ['SH', 'SZ', 'BJ'].includes(current);
}
export interface DirectoryMarketState { market: SecurityMarket; count: number; updatedAt?: number; refreshing: boolean; error?: string }
export interface DirectoryState { markets: DirectoryMarketState[] }
export interface SecuritySearch { items: WatchItem[]; total: number; directory: DirectoryState }
export interface Preferences {
  shortcuts: ShortcutBindings;
  connectionMode: ConnectionMode;
  host: string; port: number; ssl: boolean;
  securityWidth: number; barPageSize: number; fontSize: number; opacity: number; autoStart: boolean;
  watchlist: WatchItem[];
  position?: { x: number; y: number };
}
export interface DisplayQuote {
  price: number; baseline?: number; baselineLabel: string; changePercent?: number;
  session: Session; sourceEpoch?: number; sourceText?: string; sourceZone: string;
  receivedAt: number; priceDecimals: number;
}
export interface StockRow extends WatchItem {
  marketState?: number; marketLabel: string;
  permission: 'unknown' | 'available' | 'denied';
  timeliness: 'unknown' | 'delayed' | 'realtime';
  status: string; error?: string; quote?: DisplayQuote; pushCount: number;
}
export interface StockState {
  settingsWarning?: string;
  shortcuts?: ShortcutStatuses;
  connection: Connection; message: string; retryAt?: number;
  preferences: Preferences; keySaved: boolean; keyInSession: boolean;
  rows: StockRow[]; updatedAt: number;
  directory?: DirectoryState;
  cloud?: CloudLoginState;
}
export interface ConnectionInput { host: string; port: number; ssl: boolean; key?: string; rememberKey: boolean; clearKey?: boolean }
export interface Result { ok: boolean; message?: string }
export interface StockBridge {
  saveShortcuts: (input: ShortcutBindings) => Promise<Result>;
  retryShortcuts: () => Promise<Result>;
  captureShortcut: (active: boolean) => Promise<Result>;
  onShortcutCapture: (listener: (capture: ShortcutCapture) => void) => () => void;
  onPage: (listener: (direction: number) => void) => () => void;
  get: () => Promise<StockState>;
  onState: (listener: (state: StockState) => void) => () => void;
  connect: (input: ConnectionInput) => Promise<Result>;
  setConnectionMode: (mode: ConnectionMode) => Promise<Result>;
  loginCloud: () => Promise<Result>;
  cancelCloudLogin: () => Promise<Result>;
  logoutCloud: () => Promise<Result>;
  lookup: (symbol: string) => Promise<{ item?: WatchItem; message?: string }>;
  search: (query: string, market: SearchMarket) => Promise<SecuritySearch>;
  refreshDirectory: () => Promise<Result>;
  add: (symbol: string) => Promise<Result>;
  setWatchlist: (items: WatchItem[]) => Promise<Result>;
  saveAppearance: (input: Appearance) => Promise<Result>;
  openSettings: () => void;
  openOverview: () => void;
  toggleOverview: () => void;
  closeOverview: () => void;
  onOverview: (listener: (open: boolean) => void) => () => void;
  onNotice: (listener: (message: string) => void) => () => void;
  menu: () => void;
  hide: () => void;
  ready: () => void;
}
export const DEFAULT_PREFERENCES: Preferences = {
  shortcuts: DEFAULT_SHORTCUTS,
  connectionMode: 'cloud',
  host: '127.0.0.1', port: 33333, ssl: false, securityWidth: 180, barPageSize: 3, fontSize: 14, opacity: 1,
  autoStart: false, watchlist: [],
};
export const SESSION_LABEL: Record<Session, string> = { regular: '常规', pre: '盘前', after: '盘后', overnight: '夜盘' };
export function normalizeSymbol(value: unknown): string {
  if (typeof value !== 'string') throw new Error('请输入准确证券代码');
  const symbol = value.trim().toUpperCase();
  if (!/^(HK\.\d{5}|US\.[A-Z][A-Z0-9.-]{0,19}|(?:SH|SZ|BJ)\.\d{6})$/.test(symbol)) throw new Error('请使用 HK.00700、US.AAPL、SH.600519、SZ.000001 格式');
  return symbol;
}
export function validateConnection(value: unknown): ConnectionInput {
  if (!value || typeof value !== 'object') throw new Error('连接参数无效');
  const data = value as Record<string, unknown>;
  if (!['127.0.0.1', 'localhost'].includes(String(data.host))) throw new Error('当前版本仅连接本机 OpenD');
  if (!Number.isInteger(data.port) || Number(data.port) < 1 || Number(data.port) > 65535) throw new Error('端口必须为 1～65535 的整数');
  if (typeof data.ssl !== 'boolean' || typeof data.rememberKey !== 'boolean') throw new Error('连接参数无效');
  if (data.key !== undefined && (typeof data.key !== 'string' || data.key.length > 4096)) throw new Error('密钥格式无效');
  return { host: String(data.host), port: Number(data.port), ssl: data.ssl, rememberKey: data.rememberKey,
    key: data.key as string | undefined, clearKey: data.clearKey === true };
}
export type Appearance = Pick<Preferences, 'securityWidth' | 'barPageSize' | 'fontSize' | 'opacity' | 'autoStart'>;
export function validateAppearance(value: unknown): Appearance {
  const data = value as Record<string, unknown> | null;
  if (!data || !Number.isSafeInteger(data.barPageSize) || Number(data.barPageSize) < 1) throw new Error('悬浮条每页最多显示必须为正整数');
  if (!Number.isSafeInteger(data.securityWidth) || Number(data.securityWidth) < 1) throw new Error('单只证券宽度必须为正整数');
  if (!Number.isInteger(data.fontSize) || Number(data.fontSize) < 12 || Number(data.fontSize) > 20
    || typeof data.opacity !== 'number' || data.opacity < 0.4 || data.opacity > 1 || typeof data.autoStart !== 'boolean') {
    throw new Error('字号范围 12～20，透明度 40%～100%');
  }
  return { securityWidth: Number(data.securityWidth), barPageSize: Number(data.barPageSize), fontSize: Number(data.fontSize), opacity: data.opacity, autoStart: data.autoStart };
}
export const BAR_BRAND_WIDTH = 32;
export const BAR_TOOLS_WIDTH = 48;
export const BAR_CHROME_WIDTH = BAR_BRAND_WIDTH + BAR_TOOLS_WIDTH + 2;
// Missing selection flags belong to legacy watchlists. New additions always store an explicit false.
export function barItems<T extends WatchItem>(items: T[]): T[] { return items.filter(item => item.showInBar !== false); }
export function pageSize(width: number, securityWidth: number, limit = DEFAULT_PREFERENCES.barPageSize): number {
  return Math.max(1, Math.min(limit, Math.floor((width - BAR_CHROME_WIDTH) / securityWidth)));
}
export function barWidth(availableWidth: number, securityWidth: number, securities: number, limit = DEFAULT_PREFERENCES.barPageSize): number {
  // The window depends on page capacity, never on the number of rows on the current page.
  const slots = Math.min(Math.max(1, securities), pageSize(availableWidth, securityWidth, limit));
  return Math.min(availableWidth, securities === 0 ? Math.max(360, securityWidth + BAR_CHROME_WIDTH) : slots * securityWidth + BAR_CHROME_WIDTH);
}
export function formatPrice(quote?: DisplayQuote): string {
  return quote ? quote.price.toLocaleString('en-US', { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
}
export function formatChange(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  const rounded = Math.round(Math.abs(value) * 100) / 100;
  return `${rounded === 0 ? '' : value > 0 ? '+' : '−'}${rounded.toFixed(2)}%`;
}
