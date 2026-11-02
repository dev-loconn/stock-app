import { expect, it } from 'vitest';
import { applyCloudQuote, applyCloudTickers, cloudMarketState } from '../src/main/cloud-market';
import { applyBasic, applyTrades, desiredSession, selectQuote, type QuoteBook } from '../src/main/market';

const makeBook = (): QuoteBook => ({ symbol: 'US.SOXL' });
const close = { curPrice: 100, lastClosePrice: 90, updateTime: '2026-10-29 15:59:59' };

it('maps the official active and ended overnight market states', () => {
  expect(cloudMarketState('OVERNIGHT')).toBe(37);
  expect(cloudMarketState('OVERNIGHT_BEGIN')).toBe(33);
  expect(cloudMarketState('OVERNIGHT_END')).toBe(34);
  for (const state of [13, 32, 33, 37]) expect(desiredSession('US.SOXL', state)).toBe('overnight');
  expect(desiredSession('HK.00700', 37)).toBeUndefined();
});

it('retains the same overnight quote and regular-close baseline across New York midnight', () => {
  const book = makeBook(); const before = Date.parse('2026-10-30T03:59:59Z'); const after = Date.parse('2026-10-30T04:01:00Z');
  applyBasic(book, close, before);
  applyTrades(book, [{ price: 101, timestamp: before / 1000 }], 37, before, before);
  expect(selectQuote(book, 37, after)).toMatchObject({ status: '夜盘', quote: { session: 'overnight', price: 101, baseline: 100, sourceEpoch: before } });
  expect(selectQuote(book, 37, after).quote?.changePercent).toBeCloseTo(1);
});

it('rejects earlier nights and daytime ticks when a ticker has no explicit period', () => {
  const book = makeBook(); const now = Date.parse('2026-10-30T05:00:00Z'); applyBasic(book, close, now);
  applyTrades(book, [{ price: 1, time: '2026-10-28 23:59:59' }, { price: 2, time: '2026-10-29 19:59:59' }], 37, now, now);
  expect(selectQuote(book, 37, now)).toMatchObject({ status: '待夜盘行情', quote: { session: 'regular', price: 100 } });
});

it('handles the winter-time Sunday opening and following Monday as one overnight session', () => {
  const book = makeBook(); const now = Date.parse('2026-11-02T07:00:00Z');
  applyBasic(book, { ...close, updateTime: '2026-10-30 15:59:59' }, now);
  applyTrades(book, [{ price: 102, time: '2026-11-01 20:01:00' }], 37, now, now);
  expect(selectQuote(book, 37, now).quote).toMatchObject({ session: 'overnight', price: 102, baseline: 100 });
});

it('replays the actual SOXL overnight response without using its later regular-session baseline', () => {
  const book = makeBook(); const time = 1793347193916; const now = time + 100;
  applyCloudQuote(book, { last_price: 102.39, prev_close_price: 110, data_time: Date.parse('2026-10-29T20:00:00Z') }, 37, now, false);
  applyCloudTickers(book, { code: 'US.SOXL', last_close: 102.39, ticker_list: [{ price: 85.78, time, period_type: 'OVERNIGHT' }] }, 37, now, 'OVERNIGHT');
  const quote = selectQuote(book, 37, now).quote;
  expect(quote).toMatchObject({ session: 'overnight', price: 85.78, baseline: 102.39, baselineLabel: '夜盘前最近常规收盘价', sourceEpoch: time });
  expect(quote?.changePercent).toBeCloseTo(-16.22228733, 6);
});

it('preserves the period baseline when stream and delayed REST prices cross midnight', () => {
  const book = makeBook(); const before = Date.parse('2026-10-30T03:59:59Z'); const after = Date.parse('2026-10-30T04:00:01Z');
  applyCloudQuote(book, { last_price: 100, prev_close_price: 90, data_time: Date.parse('2026-10-29T20:00:00Z') }, 37, before, false);
  applyCloudTickers(book, { last_close: 100, ticker_list: [{ price: 101, time: before, period_type: 'OVERNIGHT' }] }, 37, before, 'OVERNIGHT');
  applyCloudTickers(book, { ticker_list: [{ price: 102, time_ms: after }] }, 37, after);
  applyCloudTickers(book, { last_close: 100, ticker_list: [{ price: 101, time: before, period_type: 'OVERNIGHT' }] }, 37, after, 'OVERNIGHT');
  expect(selectQuote(book, 37, after).quote).toMatchObject({ session: 'overnight', price: 102, baseline: 100, changePercent: 2.0000000000000018 });
});

it('restores an ended overnight session at startup without relabeling older after-hours data', () => {
  const book = makeBook(); const time = Date.parse('2026-11-02T08:59:59Z'); const now = time + 2000;
  applyCloudQuote(book, { last_price: 100, prev_close_price: 90, data_time: Date.parse('2026-10-30T20:00:00Z') }, 34, now, false);
  applyCloudTickers(book, { last_close: 100, ticker_list: [{ price: 103, time, period_type: 'OVERNIGHT' }] }, 34, now, 'OVERNIGHT');
  expect(selectQuote(book, 34, now)).toMatchObject({ status: '夜盘结束', quote: { session: 'overnight', price: 103, baseline: 100 } });
  expect(selectQuote(book, 8, now)).toMatchObject({ status: '待盘前行情', quote: { session: 'overnight', price: 103, baseline: 100 } });
});

it('does not borrow the previous overnight session baseline before the new period close arrives', () => {
  const book = makeBook(); const old = Date.parse('2026-10-30T07:59:00Z'); const now = Date.parse('2026-11-02T01:01:00Z');
  applyCloudTickers(book, { last_close: 102.39, ticker_list: [{ price: 85.78, time: old, period_type: 'OVERNIGHT' }] }, 37, old, 'OVERNIGHT');
  applyCloudTickers(book, { ticker_list: [{ price: 80, time_ms: now }] }, 37, now);
  expect(selectQuote(book, 37, now).quote?.price).toBe(80);
  expect(selectQuote(book, 37, now).quote?.changePercent).toBeUndefined();
  applyCloudTickers(book, { last_close: 77.05, ticker_list: [{ price: 79.9, time: now - 1000, period_type: 'OVERNIGHT' }] }, 37, now, 'OVERNIGHT');
  expect(selectQuote(book, 37, now).quote).toMatchObject({ price: 80, baseline: 77.05 });
});
