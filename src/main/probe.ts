import { OpenDClient, list, number, object, redact, string } from './sdk';
import { validateInput, type Check, type ProbeReport, type Quote, type SymbolProbe } from '../shared/probe';

function security(symbol: string) {
  return { market: symbol.startsWith('HK.') ? 1 : 11, code: symbol.slice(3) };
}
function symbolOf(value: unknown): string | undefined {
  const item = object(value);
  if (item.market !== 1 && item.market !== 11) return undefined;
  return `${item.market === 1 ? 'HK' : 'US'}.${string(item.code)}`;
}
function quoteOf(value: unknown, symbol: string): Quote {
  const item = object(value);
  const extended = (value: unknown) => {
    if (!value || typeof value !== 'object') return undefined;
    const data = object(value);
    return { price: number(data.price), changeRate: number(data.changeRate), changeVal: number(data.changeVal) };
  };
  return {
    price: number(item.curPrice), lastClose: number(item.lastClosePrice),
    sourceTime: string(item.updateTime), sourceTimeZone: symbol.startsWith('US.') ? 'America/New_York' : 'Asia/Hong_Kong',
    receivedAt: new Date().toISOString(), preMarket: extended(item.preMarket), afterMarket: extended(item.afterMarket),
  };
}

export async function runProbe(
  value: unknown,
  outerSignal: AbortSignal,
  publish: (report: ProbeReport) => void,
  rendererReady = false,
): Promise<ProbeReport> {
  const input = validateInput(value);
  const disconnected = new AbortController();
  const signal = AbortSignal.any([outerSignal, disconnected.signal]);
  const host = input.host === '::1' ? '[::1]' : input.host;
  const report: ProbeReport = {
    startedAt: new Date().toISOString(), running: true, outcome: 'pending',
    endpoint: `${input.ssl ? 'wss' : 'ws'}://${host}:${input.port}`, keyProvided: Boolean(input.key),
    runtime: { electron: process.versions.electron, node: process.versions.node,
      sdk: require('futu-api/package.json').version as string, platform: process.platform, arch: process.arch },
    rendererReady,
    checks: [], symbols: input.symbols.map(symbol => ({ symbol, subscription: 'pending', pushCount: 0, distinctSourceTimes: [] })),
    notes: [
      '这是接入验证，不是完整行情悬浮条。仅调用行情及连接状态接口，不调用交易接口。',
      '首笔推送可能来自 OpenD 缓存；推送计数不等于观察到实时成交。',
      '此处展示原始常规价及盘前盘后字段，尚未验证跨时段涨跌基准；盘前盘后源时间未知。',
      '未取得明确的数据时延属性时保持未知，不将连接成功或 Level1 权限直接等同于实时行情。',
    ],
  };
  const emit = () => publish(structuredClone(report));
  const message = (error: unknown) => redact(error instanceof Error ? error.message : String(error), input.key);
  const add = (name: string, status: Check['status'], detail: string) => {
    report.checks.push({ name, status, detail: redact(detail, input.key) }); emit();
  };
  const update = (values: unknown[], pushed: boolean) => {
    for (const value of values) {
      const data = object(value);
      const symbol = symbolOf(data.security);
      const item = report.symbols.find(item => item.symbol === symbol);
      if (!item) continue;
      item.name = string(data.name) || item.name;
      item.quote = quoteOf(data, item.symbol);
      if (pushed) {
        item.pushCount++;
        if (item.quote.sourceTime && !item.distinctSourceTimes.includes(item.quote.sourceTime)) {
          item.distinctSourceTimes.push(item.quote.sourceTime);
        }
      }
    }
    emit();
  };
  let client: OpenDClient | undefined;
  let connected = false;
  try {
    client = new OpenDClient();
    add('SDK 加载', 'passed', '官方 futu-api 在当前进程创建成功');
    await client.connect(input, signal, response => update(list(object(object(response).s2c).basicQotList), true), () => {
      connected = false;
      add('连接中断', 'failed', '观察期间 OpenD WebSocket 已断开，本轮验证停止');
      disconnected.abort();
    });
    connected = true;
    add('WebSocket 握手', 'passed', '已完成本机 OpenD WebSocket 初始化');
    const global = await client.request('GetGlobalState', { userID: 0 }, signal);
    if (global.qotLogined !== true) throw new Error('OpenD 已连接，但行情服务器尚未登录，请到 OpenD 完成登录');
    add('行情服务器登录', 'passed', `OpenD ${global.serverVer ?? '?'} / build ${global.serverBuildNo ?? '?'}`);
    try {
      const rights = await client.request('GetUserInfo', { flag: 2 | 4 }, signal);
      add('行情权限', 'passed', `港股=${client.enumName('QotRight', rights.hkQotRight)}；美股=${client.enumName('QotRight', rights.usQotRight)}；订阅额度=${number(rights.subQuota) ?? '未知'}；具体证券时延属性待核验`);
    } catch (error) { add('行情权限', 'failed', message(error)); }

    const securityList = input.symbols.map(security);
    try {
      const staticInfo = await client.request('GetStaticInfo', { securityList }, signal);
      for (const entry of list(staticInfo.staticInfoList)) {
        const basic = object(object(entry).basic);
        const item = report.symbols.find(item => item.symbol === symbolOf(basic.security));
        if (item) { item.name = string(basic.name); item.securityType = number(basic.secType); }
      }
      add('证券静态信息', report.symbols.every(item => item.name) ? 'passed' : 'failed', '按准确代码查询名称及证券类型，未返回的证券保持未知');
    } catch (error) { add('证券静态信息', 'failed', message(error)); }
    try {
      const state = await client.request('GetMarketState', { securityList }, signal);
      for (const entry of list(state.marketInfoList)) {
        const info = object(entry);
        const item = report.symbols.find(item => item.symbol === symbolOf(info.security));
        if (item) item.marketState = client.enumName('QotMarketState', info.marketState);
      }
      add('市场状态', report.symbols.every(item => item.marketState) ? 'passed' : 'failed', '使用 OpenD 返回的市场状态，不按本地钟点猜测');
    } catch (error) { add('市场状态', 'failed', message(error)); }

    await Promise.all(report.symbols.map(async (item: SymbolProbe) => {
      try {
        await client!.request('Sub', { securityList: [security(item.symbol)], subTypeList: [1],
          isSubOrUnSub: true, isRegOrUnRegPush: true, isFirstPush: true }, signal);
        item.subscription = 'passed'; emit();
        const data = await client!.request('GetBasicQot', { securityList: [security(item.symbol)] }, signal);
        update(list(data.basicQotList), false);
      } catch (error) {
        if (item.subscription === 'pending') item.subscription = 'failed';
        item.error = message(error); emit();
      }
    }));
    add('观察报价推送', 'pending', `观察 ${input.observeMs / 1000} 秒；首推可能为缓存，休市也可能没有后续更新`);
    await new Promise<void>((resolve, reject) => {
      const finish = () => { signal.removeEventListener('abort', stop); resolve(); };
      const timer = setTimeout(finish, input.observeMs);
      const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(new Error('验证已停止')); };
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) stop();
    });
    const observation = report.checks.find(check => check.name === '观察报价推送')!;
    observation.status = report.symbols.some(item => item.pushCount > 0) ? 'passed' : 'failed';
    observation.detail = report.symbols.map(item => `${item.symbol}: ${item.pushCount} 次推送 / ${item.distinctSourceTimes.length} 个不同源时间`).join('；');
    const all = connected && report.symbols.every(item => item.subscription === 'passed' && item.quote?.price !== undefined && item.pushCount > 0)
      && report.checks.every(check => check.status === 'passed');
    report.outcome = all ? 'passed' : connected && report.symbols.some(item => item.quote?.price !== undefined) ? 'partial' : 'failed';
  } catch (error) {
    add('本轮结果', 'failed', message(error));
    report.outcome = 'failed';
  } finally {
    client?.close();
    report.running = false;
    report.finishedAt = new Date().toISOString();
    emit();
    input.key = '';
  }
  return report;
}
