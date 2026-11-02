import { net, session } from 'electron';
import { ProxyAgent, WebSocket } from 'undici';
import { CLOUD_API, CLOUD_SOCKET, CloudError, obj, type CloudRequest } from './cloud-api';

// Chromium handles the user's system proxy and TLS trust for HTTPS. Credentials never follow redirects.
export const cloudRequest: CloudRequest = async (path, options = {}) => {
  if (!/^\/(oauth2\/(register|token)|api\/v1\.0\/(server-time|quote\/[a-z-]+|quote\/US\.[A-Z0-9.-]+\/rt-ticker\?num=100&period=(BEFORE|AFTER|OVERNIGHT)))$/.test(path)) throw new CloudError('云端接口路径无效');
  const form = options.body instanceof URLSearchParams;
  let response: Response;
  try {
    response = await net.fetch(CLOUD_API + path, { method: options.body ? 'POST' : 'GET', redirect: 'error',
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
      headers: { ...(options.body ? { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
      body: options.body ? form ? options.body.toString() : JSON.stringify(options.body) : undefined });
  } catch { throw new CloudError('云端网络请求失败，请检查网络或代理后重试'); }
  const data = obj(await response.json().catch(() => ({})));
  const code = data.ret_code ?? data.code ?? data.error;
  if (!response.ok || (code !== undefined && code !== 0)) {
    const loginRequired = response.status === 401 || ['invalid_grant', 'invalid_token', -12102, -12006].includes(code as string | number);
    throw new CloudError(loginRequired ? '云端授权已失效，请重新登录富途' : response.status === 429 || code === -12011
      ? '云端请求过于频繁，稍后自动重试' : `云端请求失败（${typeof code === 'number' ? code : response.status}）`,
    typeof code === 'string' || typeof code === 'number' ? code : response.status, loginRequired);
  }
  return data;
};

export type CloudSocket = Pick<WebSocket, 'addEventListener' | 'removeEventListener' | 'send' | 'close' | 'readyState'>;
export async function openCloudSocket(): Promise<{ socket: CloudSocket; release: () => void }> {
  const configured = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const resolved = configured ? '' : await session.defaultSession.resolveProxy(CLOUD_SOCKET.replace('wss:', 'https:'));
  const match = resolved.match(/^(PROXY|HTTPS) ([^;]+)/);
  const proxy = configured || (match ? `${match[1] === 'HTTPS' ? 'https' : 'http'}://${match[2]}` : undefined);
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  const socket = new WebSocket(CLOUD_SOCKET, { dispatcher });
  return { socket, release: () => { socket.close(); if (dispatcher) void dispatcher.destroy(); } };
}
