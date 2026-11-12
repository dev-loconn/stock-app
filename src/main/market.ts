import { SESSION_LABEL, type DisplayQuote, type Session } from '../shared/stock';
import { number, object, string } from './sdk';

export interface BasicTick { price?: number; previousClose?: number; epoch?: number; text?: string; spread?: number; suspended: boolean }
export interface Trade { price: number; epoch: number; text: string; receivedAt: number; baseline?: number; sequence?: bigint }
export interface QuoteBook {
  symbol: string; basic?: BasicTick; basicReceivedAt?: number;
  pre?: Trade; after?: Trade; overnight?: Trade; last?: DisplayQuote;
}
export function zoneFor(symbol: string): string { return symbol.startsWith('US.') ? 'America/New_York' : symbol.startsWith('HK.') ? 'Asia/Hong_Kong' : 'Asia/Shanghai'; }
const formatters = new Map<string, Intl.DateTimeFormat>();
// OpenD Qot_Common.TickerType: extended-hours sold out of sequence and OTC sold out of sequence.
const outOfSequenceTradeTypes = new Set([22, 25]);
function parts(epoch: number, zone: string) {
  if (!formatters.has(zone)) formatters.set(zone, new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }));
  const values = formatters.get(zone)!.formatToParts(epoch);
  return Object.fromEntries(values.map(item => [item.type, item.value]));
}
export function marketDate(epoch: number, zone: string): string {
  const value = parts(epoch, zone); return `${value.year}-${value.month}-${value.day}`;
}
export function sessionDate(session: Session, epoch: number, zone: string): string {
  const value = parts(epoch, zone);
  if (session === 'overnight' && Number(value.hour) >= 20) {
    // Advance the local calendar, not 24 elapsed hours, across DST changes.
    return new Date(Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day) + 1)).toISOString().slice(0, 10);
  }
  return `${value.year}-${value.month}-${value.day}`;
}
export function isExtendedSession(session?: Session): session is Exclude<Session, 'regular'> {
  return session === 'pre' || session === 'after' || session === 'overnight';
}
export function sourceEpoch(text: unknown, timestamp: unknown, zone: string): number | undefined {
  const seconds = number(timestamp);
  if (seconds && seconds > 0 && Number.isFinite(new Date(seconds * 1000).getTime())) return seconds * 1000;
  const match = string(text)?.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:[.:](\d{1,3}))?$/);
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return undefined;
  const local = Date.UTC(year, month - 1, day, hour, minute, second);
  let epoch = local;
  for (let i = 0; i < 2; i++) {
    const zoned = parts(epoch, zone);
    const interpreted = Date.UTC(Number(zoned.year), Number(zoned.month) - 1, Number(zoned.day), Number(zoned.hour), Number(zoned.minute), Number(zoned.second));
    epoch += local - interpreted;
  }
  return epoch + Number((match[7] || '').padEnd(3, '0'));
}
export function parseBasic(value: unknown, symbol: string): BasicTick {
  const data = object(value);
  const positive = (value: unknown) => { const result = number(value); return result !== undefined && result > 0 ? result : undefined; };
  return { price: positive(data.curPrice), previousClose: positive(data.lastClosePrice),
    epoch: sourceEpoch(data.updateTime, data.updateTimestamp, zoneFor(symbol)), text: string(data.updateTime),
    spread: positive(data.priceSpread), suspended: data.isSuspended === true };
}
export function applyBasic(book: QuoteBook, value: unknown, receivedAt: number): void {
  const next = parseBasic(value, book.symbol);
  if (next.price === undefined) return;
  if (book.basic?.epoch && next.epoch && next.epoch < book.basic.epoch) return;
  book.basic = next; book.basicReceivedAt = receivedAt;
}
export function desiredSession(symbol: string, state?: number): Session | undefined {
  if (symbol.startsWith('US.') && state === 8) return 'pre';
  if (symbol.startsWith('US.') && state === 10) return 'after';
  if (symbol.startsWith('US.') && [13, 32, 33, 37].includes(state ?? -1)) return 'overnight';
  if ([1, 2, 3, 5, 19].includes(state ?? -1)) return 'regular';
  return undefined;
}
export function marketLabel(state?: number): string {
  return ({ 0: '休市', 1: '竞价', 2: '待开盘', 3: '盘中', 4: '午休', 5: '盘中', 6: '休市',
    8: '盘前', 9: '盘前结束', 10: '盘后', 11: '盘后结束', 12: '切换交易日', 19: '收市竞价',
    13: '夜盘', 14: '夜盘结束', 30: '收市竞价', 31: '休市', 32: '夜盘', 33: '夜盘', 34: '夜盘结束', 37: '夜盘' } as Record<number, string>)[state ?? -1] || '时段未知';
}
export function applyTrades(book: QuoteBook, values: unknown[], state: number | undefined, serverNow: number | undefined, receivedAt: number): void {
  if (!serverNow) return;
  const session = desiredSession(book.symbol, state);
  if (!isExtendedSession(session)) return;
  const zone = zoneFor(book.symbol);
  const date = sessionDate(session, serverNow, zone);
  for (const value of values) {
    const data = object(value);
    if (outOfSequenceTradeTypes.has(number(data.type) ?? 0)) continue;
    const epoch = sourceEpoch(data.time, data.timestamp, zone);
    const price = number(data.price);
    if (!epoch || !price || price <= 0 || sessionDate(session, epoch, zone) !== date || epoch > serverNow + 5000) continue;
    const time = parts(epoch, zone); const minutes = Number(time.hour) * 60 + Number(time.minute);
    if (session === 'pre' && (minutes < 240 || minutes >= 570)) continue;
    if (session === 'overnight' && minutes >= 240 && minutes < 1200) continue;
    if (session === 'after') {
      if (minutes >= 1200) continue;
      const sameDayRegular = book.basic?.epoch && marketDate(book.basic.epoch, zone) === date;
      if (sameDayRegular ? epoch <= book.basic!.epoch! : minutes < 960) continue;
    }
    const previous = book[session];
    if (previous && epoch < previous.epoch) continue;
    // OpenD uses a 64-bit sequence. Preserve its precision for trades at the same source time.
    const rawSequence = data.sequence;
    const sequenceText = typeof rawSequence === 'number' && !Number.isSafeInteger(rawSequence) ? '' : String(rawSequence);
    const sequence = /^-?\d{1,19}$/.test(sequenceText) ? BigInt(sequenceText) : undefined;
    if (previous?.epoch === epoch && previous.sequence !== undefined && sequence !== undefined && sequence <= previous.sequence) continue;

    const hasPeriodBaseline = previous && sessionDate(session, previous.epoch, zone) === date && 'baseline' in previous;
    const baseline = hasPeriodBaseline ? previous.baseline : regularBaseline(book, session, epoch);
    // QUOTE and TICKER share the same period book. Keep its confirmed close
    // (including an explicitly unknown close) when either feed updates price.
    book[session] = { price, epoch, text: string(data.time) || '', receivedAt, sequence,
      ...(hasPeriodBaseline || session === 'overnight' ? { baseline } : {}) };
  }
}
function regularBaseline(book: QuoteBook, session: Session, epoch: number): number | undefined {
  const basic = book.basic; if (!basic?.epoch) return undefined;
  const zone = zoneFor(book.symbol); const date = sessionDate(session, epoch, zone);
  const regularDate = marketDate(basic.epoch, zone);
  if (session === 'pre') {
    // Before the new regular session, last_price is still the previous day's
    // close; prev_close_price belongs to the trading day before that.
    return regularDate === date ? basic.previousClose : regularDate < date && basic.epoch < epoch ? basic.price : undefined;
  }
  if (session === 'after') return regularDate === date ? basic.price : undefined;
  return regularDate < date && basic.epoch < epoch ? basic.price : undefined;
}
function decimals(price: number, spread?: number): number {
  return Math.min(6, Math.max(2, String(price).split('.')[1]?.length || 0, String(spread || 0).split('.')[1]?.length || 0));
}
function makeQuote(book: QuoteBook, session: Session, price: number, baseline: number | undefined, epoch: number | undefined, text: string | undefined, receivedAt: number): DisplayQuote {
  return { price, baseline, baselineLabel: session === 'overnight' ? '夜盘前最近常规收盘价' : session === 'after' ? '当日常规收盘价' : '上一交易日常规收盘价',
    changePercent: baseline && baseline > 0 ? (price / baseline - 1) * 100 : undefined,
    session, sourceEpoch: epoch, sourceText: text, sourceZone: zoneFor(book.symbol), receivedAt,
    priceDecimals: decimals(price, book.basic?.spread) };
}
export function selectQuote(book: QuoteBook, state?: number, serverNow?: number): { quote?: DisplayQuote; status: string } {
  const basic = book.basic;
  const wanted = desiredSession(book.symbol, state);
  const zone = zoneFor(book.symbol);
  const today = serverNow ? marketDate(serverNow, zone) : undefined;
  const regular = basic?.price !== undefined ? makeQuote(book, 'regular', basic.price, basic.previousClose, basic.epoch, basic.text, book.basicReceivedAt || 0) : undefined;
  let selected: DisplayQuote | undefined;
  if (isExtendedSession(wanted)) {
    const trade = book[wanted];
    if (trade && serverNow && sessionDate(wanted, trade.epoch, zone) === sessionDate(wanted, serverNow, zone)) {
      const baseline = 'baseline' in trade ? trade.baseline : regularBaseline(book, wanted, trade.epoch);
      selected = makeQuote(book, wanted, trade.price, baseline, trade.epoch, trade.text, trade.receivedAt);
    }
  } else if (wanted === 'regular') {
    if (regular && today && regular.sourceEpoch && marketDate(regular.sourceEpoch, zone) === today) selected = regular;
  } else {
    selected = book.last;
    if (regular && (!selected?.sourceEpoch || (regular.sourceEpoch || 0) >= selected.sourceEpoch)) selected = regular;
  }
  if (selected) book.last = selected;
  const fallback = selected || book.last || regular;
  let status = marketLabel(state);
  if (wanted && !selected) status = `待${SESSION_LABEL[wanted]}行情`;
  if (basic?.suspended) status = '停牌';
  return { quote: fallback, status };
}
