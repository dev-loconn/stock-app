import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CloudAuth } from './cloud-auth';
import { cloudError, entries, obj, type CloudRequest } from './cloud-api';
import type { SecurityCatalog } from './security-catalog';

// Explicit --catalog-cloud-live-check diagnostic. Reuses the app's own auth context;
// never modifies the watchlist or exports credentials, account identifiers or raw responses.
export async function checkCatalogCloud(catalog: SecurityCatalog, auth: CloudAuth, request: CloudRequest) {
  const beijing = catalog.search('920', 'BJ').items[0]?.symbol;
  const symbols = ['HK.00700', 'US.AAPL', 'SH.600519', 'SZ.000001', ...(beijing ? [beijing] : [])];
  const token = await auth.token();
  const checks: Record<string, unknown>[] = [];
  for (const [endpoint, field] of [['stock-basicinfo', 'basic_list'], ['market-state', 'market_state_list'], ['stock-quote', 'quote_list'], ['snapshot', 'snapshot_list']]) {
    try {
      const response = await request('/api/v1.0/quote/' + endpoint, { token, body: { code_list: symbols } });
      const values = entries(obj(response.data)[field]);
      checks.push({ endpoint, ok: true, securities: symbols.map(symbol => {
        const value = values.find(item => item.code === symbol);
        return { symbol, returned: Boolean(value), ...(['stock-quote', 'snapshot'].includes(endpoint) ? { hasPrice: typeof value?.last_price === 'number' && value.last_price > 0 }
          : endpoint === 'stock-basicinfo' ? { type: value?.stock_type } : { marketState: value?.market_state }) };
      }) });
    } catch (error) { checks.push({ endpoint, ok: false, message: cloudError(error) }); }
  }
  await mkdir(resolve('artifacts'), { recursive: true });
  await writeFile(resolve('artifacts/akshare-cloud-live-authenticated.json'), JSON.stringify({ checkedAt: new Date().toISOString(),
    authenticated: true, directory: catalog.state(), checks }, null, 2) + '\n');
}
