import type { WatchItem } from './stock';

// These user-confirmed tickers must not depend on translated fund names.
const TICKER_TITLES = new Set(['US.SOXL', 'US.SOXS', 'US.TQQQ']);
const CHINESE_DIRECTION = /[杠槓][杆桿]|反向|做[多空]|[二两兩三四五六七八九十]倍/;
const ENGLISH_DIRECTION = /\b(?:leveraged|inverse)\b|\bproshares\s+(?:ultra(?:pro)?(?:short)?|short)(?!(?:[-\s]+short)?[-\s]+(?:term|duration|maturity|bond))\b/i;

function hasDirectionalName(name: string): boolean {
  const text = name.normalize('NFKC').replaceAll('−', '-');
  if (CHINESE_DIRECTION.test(text) || ENGLISH_DIRECTION.test(text)) return true;
  // A positive 1x multiplier alone is an ordinary tracker, not leverage.
  return Array.from(text.matchAll(/(?<![\w.])(-?\d+(?:\.\d+)?)\s*(?:x\b|倍)/gi))
    .some(match => Number(match[1]) > 1 || Number(match[1]) < 0);
}

export function barSecurityTitle(item: WatchItem): string {
  if (!item.symbol.startsWith('US.') || item.securityType !== 4) return item.name;
  return TICKER_TITLES.has(item.symbol) || [item.name, ...(item.aliases || [])].some(hasDirectionalName)
    ? item.symbol.slice(3) : item.name;
}
