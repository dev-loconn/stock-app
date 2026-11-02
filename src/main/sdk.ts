import type { Root } from 'protobufjs';
import { createHash } from 'node:crypto';

type Payload = Record<string, unknown>;
interface SdkTransport {
  close: () => void;
  websock: WebSocket;
  unpackBuff: (data: ArrayBuffer) => { cmd: number; buff?: ArrayBuffer } | null;
  onclose?: () => void;
  onerror?: () => void;
  promisePool: Record<string, { timer?: ReturnType<typeof setTimeout> }>;
}
interface SdkInstance {
  start: (host: string, port: number, ssl: boolean, key: string | null) => void;
  stop: () => void;
  onlogin: ((ok: boolean, detail: unknown) => void) | null;
  onPush: ((cmd: number, response: unknown) => void) | null;
  websock: SdkTransport | null;
  GetGlobalState: (request: Payload) => Promise<unknown>;
  GetUserInfo?: (request: Payload) => Promise<unknown>;
  _sendCmd: (command: number, request: Payload, name: string) => Promise<unknown>;
  GetStaticInfo: (request: Payload) => Promise<unknown>;
  GetMarketState: (request: Payload) => Promise<unknown>;
  GetBasicQot: (request: Payload) => Promise<unknown>;
  GetTicker: (request: Payload) => Promise<unknown>;
  GetSecuritySnapshot: (request: Payload) => Promise<unknown>;
  Sub: (request: Payload) => Promise<unknown>;
}
export type ReadOnlyMethod = 'GetGlobalState' | 'GetUserInfo' | 'GetStaticInfo' | 'GetMarketState' | 'GetBasicQot' | 'GetTicker' | 'GetSecuritySnapshot' | 'Sub';

export function object(value: unknown): Payload {
  return value && typeof value === 'object' ? value as Payload : {};
}
export function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
export function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
export function string(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }

export function redact(message: string, key: string): string {
  if (!key) return message.slice(0, 500);
  return [key, createHash('md5').update(key).digest('hex')]
    .reduce((text, secret) => text.split(secret).join('<REDACTED>'), message).slice(0, 500);
}
function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  const response = object(error);
  return string(response.retMsg) || string(response.errmsg) || `接口失败（retType=${response.retType ?? '未知'}）`;
}

/** The SDK's stop() only unregisters pushes. This pinned-version boundary also closes its transport. */
export class OpenDClient {
  private sdk: SdkInstance;
  private root: Root;
  private ended = false;
  private handshakeError: string | undefined;
  private key = '';

  constructor() {
    const module = require('futu-api') as { default: new () => SdkInstance };
    this.root = require('futu-api/proto.js') as Root;
    this.sdk = new module.default();
  }

  enumName(name: string, value: unknown): string {
    const code = number(value);
    if (code === undefined) return '未知';
    return this.root.lookupEnum(`Qot_Common.${name}`).valuesById[code] ?? `未知(${code})`;
  }

  async connect(
    input: { host: string; port: number; ssl: boolean; key: string },
    signal: AbortSignal,
    onPush: (response: unknown) => void,
    onDisconnect: () => void,
    onEvent?: (command: number, response: unknown) => void,
  ): Promise<void> {
    if (signal.aborted) throw new Error('验证已停止');
    this.key = input.key;
    this.sdk.onPush = (cmd, response) => {
      if (!this.ended && cmd === 3005) onPush(response);
      if (!this.ended && cmd === 3011) onEvent?.(cmd, response);
    };
    const login = new Promise<void>((resolve, reject) => {
      this.sdk.onlogin = (ok, detail) => {
        if (this.ended) return;
        if (ok) resolve();
        else reject(new Error(this.handshakeError || `OpenD 握手失败：${errorText(detail)}。请核对 WebSocket 密钥及 OpenD 登录状态。`));
      };
      this.sdk.start(input.host, input.port, input.ssl, input.key || null);
      const transport = this.sdk.websock;
      if (!transport) { reject(new Error('SDK 未创建 WebSocket 连接')); return; }
      // The SDK dereferences s2c before checking InitWebSocket.retType. Capture only safe diagnostics.
      transport.websock.addEventListener('message', (event: MessageEvent<ArrayBuffer>) => {
        if (this.ended) return;
        try {
          const packet = transport.unpackBuff(event.data);
          if (packet?.cmd !== 1 || !packet.buff) return;
          const response = object(this.root.lookupType('InitWebSocket.Response').decode(new Uint8Array(packet.buff)));
          if (response.retType !== 0 || !response.s2c) {
            this.handshakeError = `OpenD WebSocket 握手被拒绝（retType=${response.retType}）：${string(response.retMsg) || '未提供错误说明'}。请核对 WebSocket 密钥及 OpenD 登录状态。`;
          }
        } catch { /* The normal SDK path owns protocol decoding errors. */ }
      });
      transport.onerror = () => reject(new Error('本机 WebSocket 连接失败，请检查端口和 SSL 配置'));
      transport.onclose = () => {
        if (!this.ended) {
          reject(new Error('OpenD 连接已断开'));
          onDisconnect();
        }
      };
    });
    await this.wait(login, signal, 10000);
  }

  async request(method: ReadOnlyMethod, c2s: Payload, signal: AbortSignal, timeout = 6000): Promise<Payload> {
    if (signal.aborted || this.ended) throw new Error('验证已停止');
    // 10.11.7108 declares command 1005 and its protobuf, but omits the convenience method.
    const request = method === 'GetUserInfo' && typeof this.sdk.GetUserInfo !== 'function'
      ? this.sdk._sendCmd(1005, { c2s }, 'GetUserInfo')
      : this.sdk[method]!({ c2s });
    const response = object(await this.wait(request, signal, timeout));
    if (response.retType !== 0) throw new Error(redact(errorText(response), this.key));
    return object(response.s2c);
  }

  private wait<T>(promise: Promise<T>, signal: AbortSignal, timeout: number): Promise<T> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error('验证已停止')); return; }
      const timer = setTimeout(() => finish(new Error('接口等待超时')), timeout);
      const abort = () => finish(new Error('验证已停止'));
      const finish = (error?: Error, value?: T) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (error) reject(new Error(redact(error.message, this.key)));
        else resolve(value as T);
      };
      signal.addEventListener('abort', abort, { once: true });
      promise.then(value => finish(undefined, value), error => finish(new Error(redact(errorText(error), this.key))));
    });
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    const transport = this.sdk.websock;
    this.sdk.onlogin = null;
    this.sdk.onPush = null;
    this.sdk.stop();
    if (transport) {
      for (const pending of Object.values(transport.promisePool)) clearTimeout(pending.timer);
      transport.websock.onopen = null;
      transport.websock.onmessage = null;
      transport.websock.onerror = null;
      transport.websock.onclose = null;
      transport.close();
    }
    this.key = '';
  }
}
