import { describe, expect, it } from 'vitest';
import { applyBasic, applyTrades, marketDate, selectQuote, sourceEpoch, type QuoteBook } from '../src/main/market';
import { BAR_CHROME_WIDTH, barItems, barWidth, formatChange, pageSize, validateAppearance, DEFAULT_PREFERENCES } from '../src/shared/stock';

const now = Date.parse('2026-10-23T20:01:00Z'); // 16:01 New York, DST.
const book = (): QuoteBook => ({ symbol: 'US.AAPL' });
const basic = (price: number, close: number, text = '2026-10-23 15:59:59') => ({ curPrice: price, lastClosePrice: close, updateTime: text, priceSpread: 0.01 });

describe('quote session selection and calculation', () => {
  it('calculates regular changes against previous regular close', () => {
    const value = book(); applyBasic(value, basic(102, 100), now);
    expect(selectQuote(value, 5, now).quote).toMatchObject({ price: 102, baseline: 100, session: 'regular' });
    expect(selectQuote(value, 5, now).quote?.changePercent).toBeCloseTo(2);
  });
  it('uses timestamped pre-market trades and previous close, ignoring un-timestamped extended fields', () => {
    const value = book(); const preNow = Date.parse('2026-10-23T12:30:00Z');
    applyBasic(value, { ...basic(100, 90, '2026-10-22 15:59:59'), preMarket: { price: 900 } }, preNow);
    expect(selectQuote(value, 8, preNow).status).toBe('待盘前行情');
    applyTrades(value, [{ price: 98, time: '2026-10-23 08:29:59' }], 8, preNow, preNow);
    expect(selectQuote(value, 8, preNow).quote).toMatchObject({ price: 98, baseline: 100, session: 'pre' });
    expect(selectQuote(value, 8, preNow).quote?.changePercent).toBeCloseTo(-2);
  });
  it('uses same-day regular close for after-hours, never previous-day close', () => {
    const value = book(); applyBasic(value, basic(100, 90), now);
    applyTrades(value, [{ price: 103, time: '2026-10-23 16:00:59' }], 10, now, now);
    expect(selectQuote(value, 10, now).quote).toMatchObject({ price: 103, baseline: 100, session: 'after' });
    expect(selectQuote(value, 10, now).quote?.changePercent).toBeCloseTo(3);
  });
  it('supports early closes without a fixed 16:00 assumption', () => {
    const value = book(); const early = Date.parse('2026-11-27T18:10:00Z');
    applyBasic(value, basic(100, 90, '2026-11-27 12:59:59'), early);
    applyTrades(value, [{ price: 102, time: '2026-11-27 13:09:00' }], 10, early, early);
    expect(selectQuote(value, 10, early).quote?.session).toBe('after');
  });
  it('preserves coherent old quotes when a new session has not produced data', () => {
    const value = book(); applyBasic(value, basic(102, 100), now);
    const previous = selectQuote(value, 5, now).quote;
    const next = selectQuote(value, 10, now);
    expect(next.status).toBe('待盘后行情'); expect(next.quote).toEqual(previous);
    applyTrades(value, [{ price: 500, time: '2026-10-22 16:01:00' }], 10, now, now);
    expect(selectQuote(value, 10, now).quote).toEqual(previous);
  });
  it('shows verified after-hours price with an unknown percentage when same-day close is unavailable', () => {
    const value = book(); applyBasic(value, basic(100, 90, '2026-10-22 15:59:59'), now);
    applyTrades(value, [{ price: 103, time: '2026-10-23 16:00:59' }], 10, now, now);
    expect(selectQuote(value, 10, now)).toMatchObject({ status: '盘后', quote: { session: 'after', price: 103 } });
    expect(selectQuote(value, 10, now).quote?.changePercent).toBeUndefined();
  });
  it('retains the after-hours quote while waiting for the first overnight trade', () => {
    const value = book(); applyBasic(value, basic(100, 90), now);
    applyTrades(value, [{ price: 103, time: '2026-10-23 16:00:59' }], 10, now, now);
    selectQuote(value, 10, now);
    expect(selectQuote(value, 32, now)).toMatchObject({ status: '待夜盘行情', quote: { session: 'after', price: 103 } });
  });
  it('does not mix a previous-day regular quote into the new regular session', () => {
    const value = book(); applyBasic(value, basic(100, 90, '2026-10-22 15:59:59'), now);
    expect(selectQuote(value, 5, now)).toMatchObject({ status: '待常规行情', quote: { sourceText: '2026-10-22 15:59:59' } });
  });
  it('keeps missing baselines and times unknown, and ignores out-of-order data', () => {
    const value = book(); applyBasic(value, basic(100, 0), now);
    applyBasic(value, basic(1, 2, '2026-10-23 10:00:00'), now + 100);
    expect(selectQuote(value, 5, now).quote?.price).toBe(100);
    expect(selectQuote(value, 5, now).quote?.changePercent).toBeUndefined();
    const unknown = book(); applyBasic(unknown, { curPrice: 101, lastClosePrice: 100 }, now);
    expect(selectQuote(unknown, 6, now).quote?.sourceEpoch).toBeUndefined();
  });
  it('retains a valid quote when a subsequent packet has no valid price, even before first display', () => {
    const value = book(); applyBasic(value, basic(102, 100), now);
    applyBasic(value, { curPrice: 0, lastClosePrice: 0, updateTime: '2026-10-23 16:00:00' }, now + 100);
    expect(selectQuote(value, 6, now).quote?.price).toBe(102);
  });
});
describe('timezones and display', () => {
  it('handles both winter and summer New York offsets and milliseconds', () => {
    expect(sourceEpoch('2026-10-23 09:30:00.123', undefined, 'America/New_York')).toBe(Date.parse('2026-10-23T13:30:00.123Z'));
    expect(sourceEpoch('2026-12-23 09:30:00:123', undefined, 'America/New_York')).toBe(Date.parse('2026-12-23T14:30:00.123Z'));
    expect(marketDate(Date.parse('2026-10-23T02:00:00Z'), 'America/New_York')).toBe('2026-10-22');
  });
  it('sizes pages responsively and avoids negative zero percentages', () => {
    expect(pageSize(900, 180)).toBe(3); expect(pageSize(360, 180)).toBe(1);
    expect(formatChange(-0.001)).toBe('0.00%'); expect(formatChange(1.25)).toBe('+1.25%'); expect(formatChange(undefined)).toBe('—');
  });
});

describe('fixed security widths', () => {
  it('uses the configured capacity while preserving tile width and screen bounds', () => {
    expect(pageSize(1920, 180, 2)).toBe(2);
    expect(pageSize(1920, 180, 8)).toBe(8);
    expect(pageSize(500, 180, 1000)).toBe(2);
    expect(barWidth(1920, 180, 2, 8)).toBe(360 + BAR_CHROME_WIDTH);
    expect(barWidth(1920, 180, 30, 8)).toBe(1440 + BAR_CHROME_WIDTH);
    expect(barWidth(500, 180, 30, 8)).toBe(360 + BAR_CHROME_WIDTH);
    for (const barPageSize of [1, 2, 20, 1000]) expect(validateAppearance({ ...DEFAULT_PREFERENCES, barPageSize }).barPageSize).toBe(barPageSize);
    for (const barPageSize of [0, -1, 1.5, NaN, Infinity, undefined, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => validateAppearance({ ...DEFAULT_PREFERENCES, barPageSize })).toThrow('正整数');
    }
  });
  it('filters only bar selections while preserving the original watchlist and order', () => {
    const items = ['HK.00700', 'US.AAPL', 'SH.600519'].map((symbol, index) => ({ symbol, name: symbol, securityType: 3, showInBar: index !== 1 }));
    expect(barItems(items).map(item => item.symbol)).toEqual(['HK.00700', 'SH.600519']);
    expect(items).toHaveLength(3);
    expect(barItems(items.map(item => ({ ...item, showInBar: false })))).toEqual([]);
  });
  it('fits whole tiles within the screen and keeps the same capacity for a partial last page', () => {
    expect(barWidth(1920, 180, 1)).toBe(180 + BAR_CHROME_WIDTH);
    expect(barWidth(1920, 180, 2)).toBe(360 + BAR_CHROME_WIDTH);
    expect(barWidth(1920, 180, 3)).toBe(540 + BAR_CHROME_WIDTH);
    expect(barWidth(1920, 180, 10)).toBe(barWidth(1920, 180, 3));
    expect(barWidth(500, 180, 10)).toBe(360 + BAR_CHROME_WIDTH);
    expect(pageSize(BAR_CHROME_WIDTH + 2 * 180 - 1, 180)).toBe(1);
    expect(pageSize(BAR_CHROME_WIDTH + 2 * 180, 180)).toBe(2);
    expect(barWidth(1920, 180, 0)).toBe(360);
    expect(barWidth(200, 360, 1)).toBe(200);
  });
  it('accepts positive safe integer widths without the former 140–360 restriction', () => {
    for (const securityWidth of [1, 96, 139, 140, 180, 360, 361, 480, 5000, Number.MAX_SAFE_INTEGER]) expect(validateAppearance({ ...DEFAULT_PREFERENCES, securityWidth }).securityWidth).toBe(securityWidth);
    for (const securityWidth of [0, -1, 180.5, NaN, Infinity, undefined, Number.MAX_SAFE_INTEGER + 1]) expect(() => validateAppearance({ ...DEFAULT_PREFERENCES, securityWidth })).toThrow('单只证券宽度必须为正整数');
  });
});
