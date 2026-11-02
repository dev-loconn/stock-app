// Run with Electron (without ELECTRON_RUN_AS_NODE). Credentials stay in the main
// process and the existing Windows-encrypted auth store; only quote facts leave it.
const { app, safeStorage, net } = require('electron');
const { join, resolve } = require('node:path');
const { mkdir, writeFile } = require('node:fs/promises');
const { CloudAuth } = require('../dist-electron/main/cloud-auth');
const { cloudRequest, openCloudSocket } = require('../dist-electron/main/cloud-network');
const { obj, entries, cloudError, CloudError } = require('../dist-electron/main/cloud-api');
const { CloudQuoteService } = require('../dist-electron/main/cloud-quotes');
const { DEFAULT_PREFERENCES } = require('../dist-electron/shared/stock');
const { applyCloudTickers } = require('../dist-electron/main/cloud-market');
const { selectQuote } = require('../dist-electron/main/market');

app.setName('stock-bar');
app.setPath('userData', join(app.getPath('appData'), 'stock-bar'));
const fields = (value, keys) => Object.fromEntries(keys.filter(key => typeof value[key] === 'number' || typeof value[key] === 'string' || typeof value[key] === 'boolean').map(key => [key, value[key]]));
const quoteFields = value => ({ ...fields(value, ['code', 'data_time', 'data_time_ms', 'data_date', 'last_price', 'prev_close_price', 'market_state']),
  ...Object.fromEntries(['pre_market', 'after_market', 'overnight'].filter(key => value[key]).map(key => [key, fields(obj(value[key]), ['price', 'change_val', 'change_rate', 'data_time', 'data_time_ms'])])) });
const observeMs = Math.min(30000, Math.max(0, Number(process.argv.find(arg => arg.startsWith('--observe-ms='))?.split('=')[1]) || 0));
app.whenReady().then(async () => {
  const report = { checkedAt: new Date().toISOString(), symbol: 'US.SOXL', checks: [] };
  try {
    const auth = new CloudAuth(join(app.getPath('appData'), 'stock-bar', 'stock-bar-cloud.json'), {
      available: () => safeStorage.isEncryptionAvailable(), encrypt: text => safeStorage.encryptString(text), decrypt: data => safeStorage.decryptString(data),
    }, cloudRequest, async () => { throw new CloudError('请先在正式应用登录'); }, () => undefined);
    await auth.load(); const token = await auth.token();
    for (const [name, path, key] of [['quote', '/api/v1.0/quote/stock-quote', 'quote_list'], ['state', '/api/v1.0/quote/market-state', 'market_state_list']]) {
      try {
        const response = await cloudRequest(path, { token, body: { code_list: [report.symbol] } });
        const values = entries(obj(response.data)[key]);
        report.checks.push({ name, values: values.map(quoteFields) });
      } catch (error) { report.checks.push({ name, error: cloudError(error) }); }
    }
    for (const period of ['BEFORE', 'AFTER', 'NORMAL', 'OVERNIGHT']) {
      try {
        const response = await net.fetch(`https://webapi.futunn.com/api/v1.0/quote/US.SOXL/rt-ticker?num=5&period=${period}`, {
          redirect: 'error', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000),
        });
        const body = obj(await response.json()); const data = obj(body.data);
        report.checks.push({ name: 'ticker-' + period, status: response.status, retCode: body.ret_code,
          ...fields(data, ['code', 'last_close']), ticks: entries(data.ticker_list).map(value => fields(value, ['price', 'time', 'period_type', 'tick_type'])) });
      } catch (error) { report.checks.push({ name: 'ticker-' + period, error: cloudError(error) }); }
    }
    const overnight = report.checks.find(check => check.name === 'ticker-OVERNIGHT');
    if (overnight?.ticks?.length) {
      const response = await cloudRequest('/api/v1.0/quote/US.SOXL/rt-ticker?num=100&period=OVERNIGHT', { token });
      const data = obj(response.data); const time = Math.max(...entries(data.ticker_list).map(tick => Number(tick.time) || 0));
      const book = { symbol: 'US.SOXL' };
      applyCloudTickers(book, data, 37, time + 100, 'OVERNIGHT');
      report.overnightReplay = { mode: 'actual captured response replay; not an active overnight session', ...selectQuote(book, 37, time + 100) };
    }
    const preferences = { ...DEFAULT_PREFERENCES, watchlist: [{ symbol: 'US.SOXL', name: 'SOXL', securityType: 4 }] };
    const frames = []; const samples = [];
    const service = new CloudQuoteService(preferences, () => {
      if (!observeMs || samples.length >= 100) return;
      const row = service.state(false).rows[0]; const quote = row?.quote;
      if (quote) samples.push({ status: row.status, ...quote });
    }, auth, cloudRequest, async () => {
      const transport = await openCloudSocket();
      if (observeMs) transport.socket.addEventListener('message', event => {
        let frame; try { frame = obj(JSON.parse(String(event.data))); } catch { return; }
        if (frame.symbol !== report.symbol || !['QUOTE', 'TICKER'].includes(frame.type) || frames.length >= 30) return;
        const data = obj(frame.data);
        frames.push({ type: frame.type, symbol: frame.symbol, data: frame.type === 'QUOTE' ? quoteFields(data) : {
          ...fields(data, ['last_close']), ticker_list: entries(data.ticker_list).slice(0, 3).map(tick => fields(tick, ['price', 'time', 'time_ms', 'period_type', 'tick_type'])) } });
      });
      return transport;
    });
    try {
      service.configure(preferences, ''); const started = Date.now();
      while (service.state(false).connection === 'connecting' && Date.now() - started < 45000) await new Promise(done => setTimeout(done, 50));
      if (observeMs) await new Promise(done => setTimeout(done, observeMs));
      const state = service.state(false);
      report.application = { connection: state.connection, message: state.message, diagnostics: service.diagnostics(),
        rows: state.rows.map(row => ({ symbol: row.symbol, marketState: row.marketState, status: row.status, error: row.error, quote: row.quote })) };
      if (observeMs) { report.frames = frames; report.samples = samples; }
    } finally { service.stop(); }
  } catch (error) { report.error = cloudError(error); }
  await mkdir(resolve('artifacts/us-sessions'), { recursive: true });
  await writeFile(resolve('artifacts/us-sessions/live-soxl.json'), JSON.stringify(report, null, 2) + '\n');
  app.exit(report.error ? 1 : 0);
}).catch(() => app.exit(1));
