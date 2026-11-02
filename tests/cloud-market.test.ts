import { expect, it } from 'vitest';
import { applyCloudQuote, applyCloudTickers } from '../src/main/cloud-market';
import { selectQuote, type QuoteBook } from '../src/main/market';

const regularTime = 1793390400359;
const regular = { code: 'US.SOXL', data_time: regularTime, data_date: '2026-10-30', last_price: 77.05, prev_close_price: 102.39,
  pre_market: { price: 82.14, change_rate: -19.777 }, after_market: { price: 78.0099, change_rate: 1.245 } };
const afterTime = 1793404799876;
const after = { code: 'US.SOXL', last_close: 77.05, ticker_list: [
  { price: 78.0012, time: afterTime, period_type: 'AFTER' }, { price: 78.01, time: afterTime - 354, period_type: 'AFTER' },
] };

it('replays the live SOXL weekend response and restores the most recent after-hours price with its own baseline', () => {
  const now = Date.parse('2026-11-01T03:05:31Z'); const book: QuoteBook = { symbol: 'US.SOXL' };
  applyCloudQuote(book, regular, 11, now, false);
  applyCloudTickers(book, after, 11, now, 'AFTER');
  const selected = selectQuote(book, 11, now);
  expect(selected).toMatchObject({ status: '盘后结束', quote: { session: 'after', price: 78.0012, baseline: 77.05, sourceEpoch: afterTime } });
  expect(selected.quote?.changePercent).toBeCloseTo(1.234523037, 6);
});

it('keeps the explicit BEFORE tag on a late pre-market print at 09:30:01 and uses the period close', () => {
  const time = 1793367001076; const book: QuoteBook = { symbol: 'US.SOXL' };
  applyCloudQuote(book, { ...regular, data_time: Date.parse('2026-10-29T20:00:00Z'), last_price: 102.39, prev_close_price: 110 }, 9, time, false);
  applyCloudTickers(book, { code: 'US.SOXL', last_close: 102.39, ticker_list: [{ price: 82.14, time, period_type: 'BEFORE' }] }, 9, time, 'BEFORE');
  const quote = selectQuote(book, 9, time).quote;
  expect(quote).toMatchObject({ session: 'pre', price: 82.14, baseline: 102.39, sourceEpoch: time });
  expect(quote?.changePercent).toBeCloseTo(-19.77732, 5);
});

it('lets an older REST reply fill the baseline without overwriting a newer stream price', () => {
  const now = afterTime + 100; const book: QuoteBook = { symbol: 'US.SOXL' };
  applyCloudQuote(book, regular, 10, now, false);
  applyCloudTickers(book, { ticker_list: [{ price: 79, time_ms: afterTime + 50, period_type: 'AFTER' }] }, 10, now);
  expect(selectQuote(book, 10, now).quote?.changePercent).toBeUndefined();
  applyCloudTickers(book, after, 10, now, 'AFTER');
  expect(selectQuote(book, 10, now).quote).toMatchObject({ price: 79, baseline: 77.05, sourceEpoch: afterTime + 50 });
  applyCloudTickers(book, { ticker_list: [{ price: 79.1, time_ms: now }] }, 10, now);
  expect(selectQuote(book, 10, now).quote).toMatchObject({ price: 79.1, baseline: 77.05 });
});

it('rejects wrong symbols, dates, periods and future ticks without borrowing another session baseline', () => {
  const now = Date.parse('2026-11-02T13:00:00Z'); const book: QuoteBook = { symbol: 'US.SOXL' };
  applyCloudQuote(book, regular, 8, now, false);
  applyCloudTickers(book, after, 8, now, 'BEFORE');
  const pre = { code: 'US.SOXL', last_close: 77.05, ticker_list: [{ price: 80, time: now, period_type: 'BEFORE' }] };
  applyCloudTickers(book, { ...pre, code: 'US.AAPL' }, 8, now, 'BEFORE');
  applyCloudTickers(book, { ...pre, ticker_list: [{ price: 80, time: now + 6000, period_type: 'BEFORE' }] }, 8, now, 'BEFORE');
  expect(book.pre).toBeUndefined(); expect(book.after).toBeUndefined();
  applyCloudTickers(book, { ...pre, last_close: 0 }, 8, now, 'BEFORE');
  const quote = selectQuote(book, 8, now).quote;
  expect(quote).toMatchObject({ price: 80, session: 'pre' }); expect(quote?.changePercent).toBeUndefined();
});

it('keeps Friday after-hours percentages unchanged when Monday regular quotes arrive', () => {
  const weekend = Date.parse('2026-11-01T03:00:00Z'); const monday = Date.parse('2026-11-02T15:00:00Z');
  const book: QuoteBook = { symbol: 'US.SOXL' };
  applyCloudQuote(book, regular, 11, weekend, false); applyCloudTickers(book, after, 11, weekend, 'AFTER');
  const old = selectQuote(book, 11, weekend).quote;
  applyCloudTickers(book, after, 8, monday, 'BEFORE');
  expect(selectQuote(book, 8, monday).quote).toEqual(old);
  applyCloudQuote(book, { last_price: 80, prev_close_price: 77.05, data_time: monday }, 5, monday, true);
  expect(selectQuote(book, 5, monday).quote).toMatchObject({ price: 80, baseline: 77.05, session: 'regular' });
});

it('keeps the first REST trade when several newest-first prints share one millisecond', () => {
  const now = afterTime + 100; const book: QuoteBook = { symbol: 'US.SOXL' };
  applyCloudQuote(book, regular, 10, now, false);
  applyCloudTickers(book, { ...after, ticker_list: [
    { price: 78.01, time: afterTime, period_type: 'AFTER' }, { price: 78, time: afterTime, period_type: 'AFTER' },
  ] }, 10, now, 'AFTER');
  expect(selectQuote(book, 10, now).quote).toMatchObject({ price: 78.01, baseline: 77.05, sourceEpoch: afterTime });
});

it('keeps the current pre-market close when a timestamped QUOTE follows the ticker backfill', () => {
  const now = Date.parse('2026-11-02T11:00:00Z'); const book: QuoteBook = { symbol: 'US.SOXL' };
  applyCloudQuote(book, regular, 8, now, false);
  applyCloudTickers(book, { code: 'US.SOXL', last_close: 77.05,
    ticker_list: [{ price: 80.67, time: now - 1000, period_type: 'BEFORE' }] }, 8, now, 'BEFORE');
  applyCloudQuote(book, { ...regular, pre_market: { price: 80.68, change_val: 3.63, change_rate: 4.711, data_time_ms: now } }, 8, now, true);
  const quote = selectQuote(book, 8, now).quote;
  expect(quote).toMatchObject({ session: 'pre', price: 80.68, baseline: 77.05 });
  expect(quote?.changePercent).toBeCloseTo(4.711226476, 6);
});

it('uses the latest completed regular close for a new-day pre-market QUOTE before ticker backfill', () => {
  const now = Date.parse('2026-11-02T11:00:00Z'); const book: QuoteBook = { symbol: 'US.SOXL' };
  applyCloudQuote(book, { ...regular, pre_market: { price: 80.68, data_time_ms: now } }, 8, now, true);
  expect(selectQuote(book, 8, now).quote).toMatchObject({ price: 80.68, baseline: 77.05 });
});

it.each([
  { state: 8, period: 'BEFORE' as const, key: 'pre_market', time: '2026-11-02T11:00:00Z', regularTime: '2026-10-30T20:00:00Z' },
  { state: 10, period: 'AFTER' as const, key: 'after_market', time: '2026-11-02T22:00:00Z', regularTime: '2026-11-02T21:00:00Z' },
  { state: 37, period: 'OVERNIGHT' as const, key: 'overnight', time: '2026-11-03T03:00:00Z', regularTime: '2026-11-02T21:00:00Z' },
])('keeps the $period baseline through alternating QUOTE and TICKER updates', sample => {
  const now = Date.parse(sample.time); const book: QuoteBook = { symbol: 'US.SOXL' };
  const basic = { last_price: 77.05, prev_close_price: 102.39, data_time: Date.parse(sample.regularTime) };
  applyCloudQuote(book, basic, sample.state, now, false);
  applyCloudTickers(book, { last_close: 77.05, ticker_list: [{ price: 80, time: now - 2000, period_type: sample.period }] }, sample.state, now, sample.period);
  applyCloudQuote(book, { ...basic, [sample.key]: { price: 80.68, data_time_ms: now - 1000 } }, sample.state, now, true);
  applyCloudTickers(book, { ticker_list: [{ price: 80.7, time_ms: now }] }, sample.state, now);
  expect(selectQuote(book, sample.state, now).quote).toMatchObject({ price: 80.7, baseline: 77.05 });
});

it('keeps the first newest-first stream trade when overnight prints share a millisecond', () => {
  const now = Date.parse('2026-11-02T08:00:00Z'); const book: QuoteBook = { symbol: 'US.SOXL' };
  applyCloudTickers(book, { last_close: 77.05, ticker_list: [{ price: 80, time: now - 1000, period_type: 'OVERNIGHT' }] }, 37, now, 'OVERNIGHT');
  applyCloudTickers(book, { ticker_list: [{ price: 80.91, time_ms: now }, { price: 80.95, time_ms: now }, { price: 80.94, time_ms: now - 1 }] }, 37, now);
  expect(selectQuote(book, 37, now).quote).toMatchObject({ price: 80.91, baseline: 77.05 });
});
