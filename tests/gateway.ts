import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Root } from 'protobufjs';
import { WebSocketServer, type WebSocket } from 'ws';

const root = require('futu-api/proto.js') as Root;
const names: Record<number, string> = {
  1: 'InitWebSocket', 1002: 'GetGlobalState', 1005: 'GetUserInfo',
  3001: 'Qot_Sub', 3004: 'Qot_GetBasicQot', 3005: 'Qot_UpdateBasicQot',
  3202: 'Qot_GetStaticInfo', 3223: 'Qot_GetMarketState', 3203: 'Qot_GetSecuritySnapshot', 3010: 'Qot_GetTicker', 3011: 'Qot_UpdateTicker',
};
type RecordValue = Record<string, unknown>;
interface Security { market: number; code: string }
export interface FixtureSecurity { symbol: string; name: string; securityType: number; delisting?: boolean }
export interface GatewayOptions { rejectKey?: string; deniedCode?: string; disconnect?: boolean; bmp?: boolean; usState?: number; failSubscriptions?: number; silentCommands?: number[]; directoryItems?: FixtureSecurity[]; invalidCode?: string; serverNow?: number; basicTime?: string; tickerTime?: string }

// Protocol fixture only: it is never used by the application or recorded as real OpenD evidence.
export async function createGateway(options: GatewayOptions = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const calls: { cmd: number; c2s: RecordValue; connection: number; at: number }[] = [];
  let connections = 0;
  let responsive = true;
  let accepting = true;
  let failures = options.failSubscriptions || 0;
  const failedDirectories = new Set<number>();
  const timers: ReturnType<typeof setTimeout>[] = [];
  function send(socket: WebSocket, cmd: number, section: bigint, payload: RecordValue) {
    const type = root.lookupType(`${names[cmd]}.Response`);
    const body = Buffer.from(type.encode(type.create(payload)).finish());
    const header = Buffer.alloc(44);
    header.write('ft-v1.0', 'utf8'); header.writeUInt32BE(cmd, 8); header.writeBigUInt64BE(section, 12);
    socket.send(Buffer.concat([header, body]));
  }
  function quote(security: Security) {
    return { security, name: 'FIXTURE ONLY', isSuspended: false, listTime: '2000-01-01', priceSpread: 0.01,
      updateTime: options.basicTime || (options.usState === 10 ? '2026-10-23 15:59:59' : '2026-10-23 10:00:00'), highPrice: 102, openPrice: 100, lowPrice: 99,
      curPrice: options.usState === 10 || [13, 32, 33, 37].includes(options.usState || 0) ? 100 : 101, lastClosePrice: 100, volume: 100, turnover: 10100, turnoverRate: 1, amplitude: 3,
      preMarket: { price: 100.5, changeRate: 0.5 }, afterMarket: { price: 102, changeRate: 0.990099 },
    };
  }
  server.on('connection', socket => {
    connections++;
    const connection = connections;
    if (!accepting) { socket.close(); return; }
    socket.on('message', raw => {
      const packet = Buffer.from(raw as Buffer);
      const cmd = packet.readUInt32BE(8);
      const section = packet.readBigUInt64BE(12);
      if (!names[cmd]) throw new Error(`Unexpected command ${cmd}`);
      const request = root.lookupType(`${names[cmd]}.Request`).decode(packet.subarray(20)) as unknown as { c2s: RecordValue };
      calls.push({ cmd, c2s: request.c2s, connection, at: Date.now() });
      if (!responsive || options.silentCommands?.includes(cmd)) return;
      const reply = (s2c: RecordValue) => send(socket, cmd, section, { retType: 0, s2c });
      if (cmd === 1) {
        if (options.rejectKey) send(socket, cmd, section, { retType: -1, retMsg: `rejected ${options.rejectKey}` });
        else reply({ connID: 123, serverTime: 1792749600 });
      } else if (cmd === 1002) reply({ marketHK: 6, marketUS: options.usState || 3, marketSH: 6, marketSZ: 6, marketHKFuture: 6,
        qotLogined: true, trdLogined: false, serverVer: 1011, serverBuildNo: 7108, time: options.serverNow ? options.serverNow / 1000 : options.usState === 10 ? Date.parse('2026-10-23T20:01:00Z') / 1000 : 1792749600 });
      else if (cmd === 1005) reply({ hkQotRight: options.bmp ? 1 : 2, usQotRight: 2, subQuota: 100,
        nickName: 'MUST NOT APPEAR', userID: 987654321, webKey: 'MUST NOT APPEAR' });
      else if (cmd === 3202) {
        if (!request.c2s.securityList?.length && failedDirectories.has(Number(request.c2s.market))) {
          send(socket, cmd, section, { retType: -1, retMsg: 'FIXTURE directory temporarily unavailable' }); return;
        }
        const requested = (request.c2s.securityList as Security[] | undefined);
        const entries = requested?.length ? requested.filter(security => security.code !== options.invalidCode).map(security => {
          const item = options.directoryItems?.find(item => item.symbol === `${security.market === 1 ? 'HK' : 'US'}.${security.code}`);
          return { security, name: item?.name || 'FIXTURE ONLY', secType: item?.securityType || 3, delisting: item?.delisting };
        }) : (options.directoryItems || []).filter(item => (item.symbol.startsWith('HK.') ? 1 : 11) === request.c2s.market && item.securityType === request.c2s.secType)
          .map(item => ({ security: { market: item.symbol.startsWith('HK.') ? 1 : 11, code: item.symbol.slice(3) }, name: item.name, secType: item.securityType, delisting: item.delisting }));
        reply({ staticInfoList: entries.map(basic => ({ basic: { ...basic, id: 1, lotSize: 1, listTime: '2000-01-01' } })) });
      }
      else if (cmd === 3223) reply({ marketInfoList: (request.c2s.securityList as Security[]).map(security => ({ security, name: 'FIXTURE ONLY', marketState: security.market === 11 ? options.usState || 3 : 3 })) });
      else if (cmd === 3001) {
        const security = (request.c2s.securityList as Security[])[0];
        if (failures > 0) { failures--; send(socket, cmd, section, { retType: -1, retMsg: '行情服务暂不可用，请重试' }); }
        else if (request.c2s.session === 4) send(socket, cmd, section, { retType: -1, retMsg: '行情订阅不支持 OVERNIGHT，请使用 ALL' });
        else if (security.code === options.deniedCode || options.bmp && security.market === 1) send(socket, cmd, section, { retType: -1, retMsg: '无行情权限' });
        else {
          reply({});
          send(socket, 3005, 0n, { retType: 0, s2c: { basicQotList: [quote(security)] } });
          if (options.disconnect) timers.push(setTimeout(() => socket.close(), 50));
        }
      } else if (cmd === 3004) reply({ basicQotList: (request.c2s.securityList as Security[]).map(quote) });
      else if (cmd === 3203) reply({ snapshotList: (request.c2s.securityList as Security[]).map(security => ({ basic: { ...quote(security), type: 3, isSuspend: false, lotSize: 1 } })) });
      else if (cmd === 3010) reply({ security: request.c2s.security, tickerList: [{ time: options.tickerTime || '2026-10-23 16:00:59', sequence: 1, dir: 0, price: 103, volume: 1, turnover: 103 }] });
    });
  });
  return {
    port: (server.address() as AddressInfo).port,
    calls,
    connections: () => connections,
    openConnections: () => server.clients.size,
    setResponsive: (value: boolean) => { responsive = value; },
    setAccepting: (value: boolean) => { accepting = value; },
    setDirectoryFailure: (market: number, value: boolean) => { if (value) failedDirectories.add(market); else failedDirectories.delete(market); },
    dropConnections: () => { for (const client of server.clients) client.terminate(); },
    pushQuotes: (securities: Security[], price: number) => {
      for (const client of server.clients) send(client, 3005, 0n, { retType: 0, s2c: { basicQotList: securities.map(security => ({ ...quote(security), curPrice: price })) } });
    },
    close: async () => {
      timers.forEach(clearTimeout);
      for (const client of server.clients) client.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
