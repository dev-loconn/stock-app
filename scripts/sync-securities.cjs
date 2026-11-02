const { resolve } = require('node:path');
const { AKShareDirectory } = require('../dist-electron/main/akshare-directory');
const { SecurityCatalog } = require('../dist-electron/main/security-catalog');
const { SECURITY_MARKETS } = require('../dist-electron/shared/stock');
async function main() {
  const source = new AKShareDirectory(resolve(__dirname, '..'));
  const args = process.argv.slice(2);
  const market = args.find(arg => arg.startsWith('--market='))?.slice(9);
  if (market && !SECURITY_MARKETS.includes(market)) throw Error('Unknown market');
  const path = resolve(args.find(arg => !arg.startsWith('--')) || '.cache/security-directory-akshare.json');
  const catalog = new SecurityCatalog(path, async market => {
    const started = Date.now();
    try {
      const items = await source.fetch(market);
      console.log(JSON.stringify({ market, count: items.length, elapsedMs: Date.now() - started }));
      return items;
    } catch (error) { console.error(JSON.stringify({ market, error: error.message })); throw error; }
  }, () => undefined, Date.now, SECURITY_MARKETS);
  await catalog.load();
  const state = await catalog.refresh(true, market ? [market] : SECURITY_MARKETS);
  console.log(JSON.stringify({ path, ...state }, null, 2));
  if (state.markets.some(market => market.error)) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
