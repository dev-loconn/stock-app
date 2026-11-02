const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validState, readOnlyScope, redactScope, quoteSummary } = require('../scripts/probe-cloud-api.cjs');

test('OAuth state rejects missing, changed and multibyte input without throwing', () => {
  const expected = 'a'.repeat(43);
  assert.equal(validState(expected, expected), true);
  for (const value of ['', 'a'.repeat(42), 'b'.repeat(43), '中'.repeat(43)]) {
    assert.equal(validState(value, expected), false);
  }
});

test('the probe requires quote read and rejects trading, watchlist write or unknown privileges', () => {
  assert.equal(readOnlyScope('quote:read accid:123 accid:456'), true);
  for (const value of ['', 'trade:read', 'quote:read trade:read', 'quote:read trade:write',
    'quote:read quote:write', 'quote:read admin:*']) assert.equal(readOnlyScope(value), false);
});

test('diagnostic evidence redacts account scope identifiers', () => {
  assert.equal(redactScope('quote:read accid:123 accid:456'), 'quote:read accid:<redacted> accid:<redacted>');
});

test('quote evidence retains market fields and excludes arbitrary credentials or account data', () => {
  assert.deepEqual(quoteSummary({ code: 'US.AAPL', last_price: 1, data_time: 123,
    access_token: 'secret', account_id: 'private', pre_market: { price: 2, access_token: 'secret' } }),
  { code: 'US.AAPL', last_price: 1, data_time: 123, pre_market: { price: 2 } });
});
