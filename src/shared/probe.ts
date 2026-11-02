export interface ProbeInput {
  host: string;
  port: number;
  ssl: boolean;
  key: string;
  symbols: string[];
  observeMs: number;
}

export type CheckStatus = 'pending' | 'passed' | 'failed';
export interface Check { name: string; status: CheckStatus; detail: string }
export interface Quote {
  price?: number;
  lastClose?: number;
  sourceTime?: string;
  sourceTimeZone: string;
  receivedAt: string;
  preMarket?: { price?: number; changeRate?: number; changeVal?: number };
  afterMarket?: { price?: number; changeRate?: number; changeVal?: number };
}
export interface SymbolProbe {
  symbol: string;
  name?: string;
  securityType?: number;
  marketState?: string;
  subscription: CheckStatus;
  error?: string;
  quote?: Quote;
  pushCount: number;
  distinctSourceTimes: string[];
}
export interface ProbeReport {
  startedAt: string;
  finishedAt?: string;
  running: boolean;
  outcome: 'pending' | 'passed' | 'partial' | 'failed';
  endpoint: string;
  keyProvided: boolean;
  runtime: { electron?: string; node: string; sdk: string; platform: string; arch: string };
  rendererReady: boolean;
  checks: Check[];
  symbols: SymbolProbe[];
  notes: string[];
}

export interface ProbeBridge {
  run: (input: ProbeInput) => Promise<{ ok: boolean; message?: string }>;
  cancel: () => Promise<void>;
  getReport: () => Promise<ProbeReport | null>;
  onReport: (listener: (report: ProbeReport) => void) => () => void;
  ready: () => void;
}

export const DEFAULT_SYMBOLS = ['HK.00700', 'HK.02800', 'US.AAPL', 'US.SPY'];

export function validateInput(value: unknown): ProbeInput {
  if (!value || typeof value !== 'object') throw new Error('连接参数格式无效');
  const input = value as Record<string, unknown>;
  if (!['127.0.0.1', 'localhost', '::1'].includes(String(input.host))) {
    throw new Error('最小验证仅允许连接本机 OpenD');
  }
  if (!Number.isInteger(input.port) || Number(input.port) < 1 || Number(input.port) > 65535) {
    throw new Error('WebSocket 端口必须为 1～65535 的整数');
  }
  if (typeof input.ssl !== 'boolean' || typeof input.key !== 'string' || input.key.length > 4096) {
    throw new Error('SSL 或密钥格式无效');
  }
  if (!Array.isArray(input.symbols) || input.symbols.length < 1 || input.symbols.length > 10) {
    throw new Error('请指定 1～10 只证券');
  }
  const symbols = input.symbols.map((symbol: unknown) => {
    if (typeof symbol !== 'string') throw new Error('证券代码格式无效');
    const normalized = symbol.trim().toUpperCase();
    if (!/^(HK\.\d{5}|US\.[A-Z][A-Z0-9.-]{0,19})$/.test(normalized)) {
      throw new Error('请使用 HK.00700、US.AAPL 格式的准确代码');
    }
    return normalized;
  });
  if (new Set(symbols).size !== symbols.length) throw new Error('证券代码不能重复');
  if (!Number.isInteger(input.observeMs) || Number(input.observeMs) < 1000 || Number(input.observeMs) > 30000) {
    throw new Error('推送观察时间必须为 1～30 秒');
  }
  return {
    host: String(input.host), port: Number(input.port), ssl: input.ssl, key: input.key,
    symbols, observeMs: Number(input.observeMs),
  };
}
