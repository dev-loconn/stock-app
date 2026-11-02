import { expect, it } from 'vitest';
import { barSecurityTitle } from '../src/shared/security-display';
import { formatPrice, type DisplayQuote, type WatchItem } from '../src/shared/stock';

const etf = (name: string, overrides: Partial<WatchItem> = {}): WatchItem => ({ symbol: 'US.TEST', name, securityType: 4, ...overrides });

it.each(['SOXL', 'SOXS', 'TQQQ'])('always uses %s for the confirmed US ETF regardless of its name', code => {
  const item = etf('没有方向特征的名称', { symbol: `US.${code}` });
  expect(barSecurityTitle(item)).toBe(code);
  expect(item.name).toBe('没有方向特征的名称');
});

it.each([
  '三倍做多测试ETF', '兩倍做空測試ETF', '槓桿測試ETF', '杠杆测试ETF', '反向测试ETF',
  '测试二倍ETF', '测试2倍ETF', 'Daily Bull 3X Shares', 'Daily Bear 2x Shares',
  'Daily 1.5x Shares', 'Daily −1x Shares', 'Daily Inverse ETF', 'Daily Leveraged ETF',
  'ProShares UltraPro QQQ', 'ProShares UltraShort Test', 'ProShares Short Test', 'Daily ２Ｘ Shares',
])('recognizes an explicit directional fund name: %s', name => {
  expect(barSecurityTitle(etf(name))).toBe('TEST');
});

it('uses existing aliases and preserves dots and hyphens inside a ticker', () => {
  expect(barSecurityTitle(etf('测试基金', { symbol: 'US.TEST.A-B', aliases: ['Daily 2x Test ETF'] }))).toBe('TEST.A-B');
});

it.each([
  '普通指数基金', 'SPDR Index ETF', 'Short-Term Bond ETF', 'Ultra Short Bond ETF',
  'Ultrashort Bond ETF', 'ProShares Short-Term Bond ETF', 'ProShares Ultra Short-Term Bond ETF',
  'Daily 1x Index ETF', 'Daily Bull Market ETF',
])('keeps an ordinary or unrecognized ETF name: %s', name => {
  expect(barSecurityTitle(etf(name))).toBe(name);
});

it('limits ticker titles to verified US ETFs', () => {
  for (const securityType of [0, 3]) expect(barSecurityTitle(etf('三倍做多测试', { symbol: 'US.SOXL', securityType }))).toBe('三倍做多测试');
  for (const symbol of ['HK.09999', 'SH.999999', 'SZ.999999', 'BJ.999999']) {
    expect(barSecurityTitle(etf('三倍做多测试', { symbol }))).toBe('三倍做多测试');
  }
});

const quote = (price: number, priceDecimals: number): DisplayQuote => ({
  price, priceDecimals, baselineLabel: '常规收盘', session: 'regular', sourceZone: 'America/New_York', receivedAt: 0,
});

it.each([
  [80.793, 3, '80.79'], [80.795, 3, '80.80'], [101, 0, '101.00'],
  [1.2, 1, '1.20'], [0.001, 3, '0.00'], [12345.6789, 4, '12345.68'],
])('displays price %s with exactly two decimals, independently of source precision %s', (price, decimals, text) => {
  const original = quote(price, decimals);
  expect(formatPrice(original)).toBe(text);
  expect(original.price).toBe(price);
});

it('keeps the placeholder when a quote is unavailable', () => {
  expect(formatPrice()).toBe('—');
});
