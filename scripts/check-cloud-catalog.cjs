// Read-only live check. Optional FUTU_ACCESS_TOKEN stays in this process; never saved or printed.
const { resolve } = require('node:path');
const { mkdir, writeFile } = require('node:fs/promises');
const { fetch, ProxyAgent } = require('undici');
const { SecurityCatalog } = require('../dist-electron/main/security-catalog');
const { SECURITY_MARKETS } = require('../dist-electron/shared/stock');
let checkApp;
let stage = 'load-directory';
async function main() {
  const catalog = new SecurityCatalog(resolve('.cache/security-directory-akshare.json'), async () => [], undefined, Date.now, SECURITY_MARKETS);
  await catalog.load();
  const searches = ['腾讯', 'apple', 'gzmt', 'payh'].map(query => ({ query, symbols: catalog.search(query).items.map(item => item.symbol) }));
  const bj = catalog.search('920', 'BJ').items[0];
  const symbols = ['HK.00700', 'US.AAPL', 'SH.600519', 'SZ.000001', ...(bj ? [bj.symbol] : [])];
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  let token = process.env.FUTU_ACCESS_TOKEN;
  let auth;
  if (process.argv.includes('--saved-login')) {
    stage = 'load-saved-login';
    const { app, safeStorage } = require('electron'); checkApp = app;
    app.setName('stock-bar');
    app.setPath('userData', resolve(app.getPath('appData'), 'stock-bar'));
    if (!app.requestSingleInstanceLock()) { app.quit(); throw Error('Close the stock bar before the saved-login check'); }
    await app.whenReady();
    stage = 'load-cloud-modules';
    const { CloudAuth } = require('../dist-electron/main/cloud-auth');
    const { cloudRequest } = require('../dist-electron/main/cloud-network');
    stage = 'decrypt-saved-login';
    const loginPath = resolve(app.getPath('appData'), 'stock-bar', 'stock-bar-cloud.json');
    auth = new CloudAuth(loginPath, {
      available: () => safeStorage.isEncryptionAvailable(), encrypt: text => safeStorage.encryptString(text), decrypt: value => safeStorage.decryptString(value),
    }, cloudRequest, async () => { throw Error('Sign in from the desktop app first'); }, () => undefined);
    await auth.load();
    if (auth.state().status !== 'authorized') { auth.stop(); app.quit(); throw Error('Saved login unavailable'); }
    stage = 'refresh-saved-login';
    try { token = await auth.token(); } catch (error) { auth.stop(); app.quit(); throw error; }
  }
  const checks = [];
  try {
    for (const endpoint of ['stock-basicinfo', 'stock-quote']) {
      stage = endpoint;
      const response = await fetch('https://webapi.futunn.com/api/v1.0/quote/' + endpoint, { method: 'POST', dispatcher,
        signal: AbortSignal.timeout(20000), redirect: 'error', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: JSON.stringify({ code_list: symbols }) });
      const body = await response.json();
      const list = body.data?.basic_list || body.data?.quote_list || [];
      checks.push({ endpoint, httpStatus: response.status, retCode: body.ret_code ?? body.code ?? null,
        returnedSymbols: list.map(item => item.code), hasPrice: endpoint === 'stock-quote' ? list.map(item => ({ symbol: item.code, available: typeof item.last_price === 'number' && item.last_price > 0 })) : undefined });
    }
  } finally { if (dispatcher) await dispatcher.close(); auth?.stop(); }
  const result = { checkedAt: new Date().toISOString(), authenticated: Boolean(token), searches, checks };
  await mkdir(resolve('artifacts'), { recursive: true });
  await writeFile(resolve('artifacts/akshare-cloud-live.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  if (checks.some(check => check.httpStatus !== 200 || check.retCode !== 0 || !check.returnedSymbols.length)) process.exitCode = 1;
}
main().catch(error => { console.error(JSON.stringify({ failedStage: stage, errorType: error.name, errorCode: typeof error.code === 'number' ? error.code : undefined })); process.exitCode = 1; })
  .finally(() => checkApp?.exit(process.exitCode || 0));
