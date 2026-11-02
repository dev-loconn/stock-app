import { applyBasic, applyTrades, desiredSession, isExtendedSession, marketDate, sessionDate, selectQuote, zoneFor, type QuoteBook } from './market';
import { entries, obj, positive, type Json } from './cloud-api';

export type CloudPeriod = 'BEFORE' | 'AFTER' | 'OVERNIGHT';

export function cloudMarketState(value: unknown): number | undefined {
  return ({ NONE: 0, AUCTION: 1, WAITING_OPEN: 2, MORNING: 3, REST: 4, AFTERNOON: 5, CLOSED: 6,
    PRE_MARKET_BEGIN: 8, PRE_MARKET_END: 9, AFTER_HOURS_BEGIN: 10, AFTER_HOURS_END: 11,
    NIGHT_OPEN: 13, NIGHT_END: 14, NIGHT: 32, OVERNIGHT_BEGIN: 33, OVERNIGHT_END: 34, OVERNIGHT: 37,
    HK_CAS: 19, TRADE_AT_LAST: 19, STIB_AFTER_HOURS_BEGIN: 19, STIB_AFTER_HOURS_END: 6 } as Record<string, number>)[String(value)];
}

// REST tickers carry their actual trading period and a last_close aligned with
// that period. REST quote objects may lack source times; streamed QUOTE objects
// can carry independent timestamps for each extended session.
export function applyCloudTickers(book: QuoteBook, data: Json, state: number | undefined, now: number | undefined, period?: CloudPeriod): void {
  if (!book.symbol.startsWith('US.') || !now || data.code !== undefined && data.code !== book.symbol) return;
  const zone = zoneFor(book.symbol);
  const wanted = desiredSession(book.symbol, state);
  const seen = new Set<number>();
  for (const value of entries(data.ticker_list)) {
    const epoch = positive(value.time_ms) || positive(value.time); const price = positive(value.price);
    if (!epoch || !price || epoch > now + 5000) continue;
    const tagged = value.period_type === 'BEFORE' ? 'pre' : value.period_type === 'AFTER' ? 'after' : value.period_type === 'OVERNIGHT' ? 'overnight' : undefined;
    if (period && value.period_type !== period) continue;
    // WebSocket tickers without a period tag still need the current market state
    // and timestamp checks; never guess their session from trade type NORMAL.
    if (!tagged) {
      if (value.period_type !== undefined) continue;
      // Stream batches are newest first, too. Distinct executions can share
      // one millisecond; a later array entry must not replace the first one.
      if (seen.has(epoch)) continue;
      seen.add(epoch);
      const previous = isExtendedSession(wanted) ? book[wanted] : undefined;
      applyTrades(book, [{ price, timestamp: epoch / 1000 }], state, now, Date.now());
      if (isExtendedSession(wanted) && book[wanted]?.epoch === epoch) {
        book[wanted]!.baseline = previous && sessionDate(wanted, previous.epoch, zone) === sessionDate(wanted, epoch, zone) ? previous.baseline : undefined;
      }
      continue;
    }
    const date = sessionDate(tagged, epoch, zone);
    if (wanted && (wanted !== tagged || date !== sessionDate(tagged, now, zone))) continue;
    // At rest, rebuild only the session belonging to the regular quote's date.
    // This keeps a stale previous-day after-hours print from replacing new data.
    if (!wanted && book.basic?.epoch) {
      const regularDate = marketDate(book.basic.epoch, zone);
      if (tagged === 'after' ? date !== regularDate : date < regularDate) continue;
    }
    const previous = book[tagged];
    if (previous && (epoch < previous.epoch || period && epoch === previous.epoch)) {
      // A newer stream price can arrive while REST is in flight. The period's
      // close is still useful, but the older REST price must not win. REST is
      // newest first, including distinct trades sharing the same millisecond.
      if (period && positive(data.last_close) && sessionDate(tagged, previous.epoch, zone) === date) previous.baseline = positive(data.last_close);
      continue;
    }
    const baseline = (period ? positive(data.last_close) : undefined) ?? (previous && sessionDate(tagged, previous.epoch, zone) === date ? previous.baseline : undefined);
    book[tagged] = { price, epoch, text: '', receivedAt: Date.now(), baseline };
    if (!wanted && epoch > (book.basic?.epoch || 0) && epoch >= (book.last?.sourceEpoch || 0)) selectQuote(book, tagged === 'pre' ? 8 : tagged === 'after' ? 10 : 37, epoch);
  }
}
export function applyCloudQuote(book: QuoteBook, data: Json, state: number | undefined, now: number | undefined, pushed: boolean): void {
  const epoch = positive(data.data_time_ms) || positive(data.data_time);
  applyBasic(book, { curPrice: data.last_price, lastClosePrice: data.prev_close_price,
    updateTimestamp: epoch ? epoch / 1000 : undefined, isSuspended: data.suspension }, Date.now());
  for (const [key, sessionState] of [['pre_market', 8], ['after_market', 10], ['overnight', 37]] as const) {
    const extended = obj(data[key]); const source = positive(extended.data_time_ms) || positive(extended.data_time);
    // REST may provide a price without a session timestamp. Never label it as current.
    if (!source || !positive(extended.price) || (now && source > now + 5000)) continue;
    const targetNow = desiredSession(book.symbol, state) === desiredSession(book.symbol, sessionState) ? now : source;
    applyTrades(book, [{ price: extended.price, timestamp: source / 1000 }], sessionState, targetNow, Date.now());
    // Preserve the last actual extended quote across market close, including startup on a weekend.
    if (!isExtendedSession(desiredSession(book.symbol, state)) && source > (book.last?.sourceEpoch || book.basic?.epoch || 0)) selectQuote(book, sessionState, source);
  }
  void pushed;
}
