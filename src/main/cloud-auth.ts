import { createServer, type ServerResponse } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CLOUD_API, CloudError, cloudError, quoteScope, type CloudRequest, type Json } from './cloud-api';
import type { CloudLoginState } from '../shared/stock';

interface Cipher { available: () => boolean; encrypt: (text: string) => Buffer; decrypt: (data: Buffer) => string }
export function matchesState(actual: string, expected: string): boolean {
  const left = Buffer.from(actual); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
export class CloudAuth {
  private clientId = '';
  private refreshToken = '';
  private accessToken = '';
  private expiresAt = 0;
  private encryptedRefresh?: string;
  private remembered = false;
  private authorizing = false;
  private message = '使用富途官方网页登录，无需安装 OpenD';
  private revision = 0;
  private pendingRefresh?: Promise<string>;
  private cancel?: () => void;
  private writes: Promise<void> = Promise.resolve();
  constructor(private file: string, private cipher: Cipher, private request: CloudRequest,
    private openBrowser: (url: string) => Promise<void>, private publish: () => void,
    private options = { port: 60356, timeoutMs: 300000 }) {}
  state(): CloudLoginState { return { status: this.authorizing ? 'authorizing' : this.refreshToken || this.accessToken ? 'authorized' : 'signedOut', remembered: this.remembered, message: this.message }; }
  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      if (typeof data.clientId === 'string') this.clientId = data.clientId;
      if (typeof data.encryptedRefresh === 'string' && this.cipher.available()) {
        this.refreshToken = this.cipher.decrypt(Buffer.from(data.encryptedRefresh, 'base64'));
        this.encryptedRefresh = data.encryptedRefresh; this.remembered = Boolean(this.refreshToken);
        this.message = this.remembered ? '已保存授权，启动后自动连接' : this.message;
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.message = '保存的云端授权无法读取，请重新登录'; }
  }
  private save(encryptedRefresh = this.encryptedRefresh): Promise<void> {
    const text = JSON.stringify({ version: 1, clientId: this.clientId, encryptedRefresh }) + '\n';
    this.writes = this.writes.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file + '.tmp', text, { mode: 0o600 }); await rename(this.file + '.tmp', this.file);
    });
    return this.writes;
  }
  private async accept(data: Json, revision: number): Promise<string> {
    if (revision !== this.revision) throw new CloudError('授权操作已取消');
    if (!quoteScope(data.scope) || typeof data.access_token !== 'string' || !data.access_token
      || typeof data.expires_in !== 'number' || data.expires_in <= 0) throw new CloudError('富途返回的授权权限无效，请仅授权行情读取');
    const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : this.refreshToken;
    const encryptedRefresh = refreshToken && this.cipher.available() ? this.cipher.encrypt(refreshToken).toString('base64') : undefined;
    await this.save(encryptedRefresh);
    if (revision !== this.revision) { await this.save(); throw new CloudError('授权操作已取消'); }
    this.accessToken = data.access_token; this.expiresAt = Date.now() + data.expires_in * 1000;
    this.refreshToken = refreshToken; this.encryptedRefresh = encryptedRefresh;
    this.remembered = Boolean(this.encryptedRefresh); this.message = this.remembered ? '已授权 · Windows 系统保护已保存登录' : '已授权 · 本次运行有效，系统保护不可用';
    this.publish(); return this.accessToken;
  }
  cancelLogin(): void { this.cancel?.(); }
  async login(): Promise<void> {
    if (this.authorizing) throw new CloudError('正在等待富途官方授权');
    const revision = ++this.revision; this.pendingRefresh = undefined;
    this.authorizing = true; this.message = '请在系统浏览器完成富途登录授权'; this.publish();
    const controller = new AbortController();
    try {
      await new Promise<void>((resolve, reject) => {
        let consumed = false; let finished = false;
        const state = randomBytes(32).toString('base64url'); const verifier = randomBytes(48).toString('base64url');
        const server = createServer((req, res) => { void callback(req.url || '/', req.headers.host || '', req.method || '', res).catch(() => {
          page(res, 400, '授权失败，请返回悬浮条设置重试。'); finish(new CloudError('富途授权失败，请重试'));
        }); });
        const timer = setTimeout(() => finish(new CloudError('登录等待超时，请重新登录')), this.options.timeoutMs);
        const finish = (error?: Error) => {
          if (finished) return; finished = true; clearTimeout(timer); this.cancel = undefined;
          controller.abort(); server.close(); setTimeout(() => server.closeAllConnections(), 1000).unref();
          if (error) reject(error); else resolve();
        };
        this.cancel = () => { this.revision++; finish(new CloudError('已取消登录')); };
        let redirectUri = '';
        const page = (res: ServerResponse, status: number, text: string) => {
          if (res.headersSent || res.destroyed) return;
          res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy': "default-src 'none'" });
          res.end(`<!doctype html><meta charset="utf-8"><title>行情悬浮条 · 富途授权</title><h1>${text}</h1>`);
        };
        const callback = async (raw: string, host: string, method: string, res: ServerResponse) => {
          const url = new URL(raw, redirectUri);
          if (method !== 'GET' || host !== new URL(redirectUri).host || url.pathname !== '/callback') { page(res, 404, '页面不存在'); return; }
          if (!matchesState(url.searchParams.get('state') || '', state)) { page(res, 400, '授权状态无效，请返回设置重新登录'); return; }
          if (consumed) { page(res, 409, '授权回调已处理'); return; } consumed = true;
          if (url.searchParams.has('error') || !url.searchParams.get('code')) { page(res, 400, '授权未完成，请返回设置'); finish(new CloudError('未完成富途授权')); return; }
          const data = await this.request('/oauth2/token', { signal: controller.signal, body: new URLSearchParams({ grant_type: 'authorization_code',
            client_id: this.clientId, redirect_uri: redirectUri, code: url.searchParams.get('code')!, code_verifier: verifier }) });
          await this.accept(data, revision);
          page(res, 200, '授权成功，可以关闭此页并返回行情悬浮条'); finish();
        };
        server.once('error', () => finish(new CloudError('无法启动本机授权回调，端口可能被占用，请稍后重试')));
        server.listen(this.options.port, '127.0.0.1', () => { void (async () => {
          const address = server.address(); if (!address || typeof address === 'string') throw new CloudError('本机回调不可用');
          redirectUri = `http://127.0.0.1:${address.port}/callback`;
          if (!this.clientId || this.options.port === 0) {
            const registered = await this.request('/oauth2/register', { signal: controller.signal, body: { redirect_uris: [redirectUri],
              token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
              client_name: 'Stock Bar Desktop', scope: 'quote:read' } });
            if (typeof registered.client_id !== 'string') throw new CloudError('云端客户端注册失败');
            if (revision !== this.revision) throw new CloudError('已取消登录');
            this.clientId = registered.client_id; await this.save();
          }
          if (revision !== this.revision) throw new CloudError('已取消登录');
          const url = new URL('/oauth2/authorize/confirm', CLOUD_API);
          url.search = new URLSearchParams({ client_id: this.clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'quote:read', state,
            code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
          await this.openBrowser(url.href);
        })().catch(error => finish(new CloudError(cloudError(error)))); });
      });
    } catch (error) { this.message = cloudError(error); throw error; }
    finally { this.authorizing = false; this.publish(); }
  }
  async token(force = false): Promise<string> {
    if (!force && this.accessToken && Date.now() < this.expiresAt - 90000) return this.accessToken;
    if (this.pendingRefresh) return this.pendingRefresh;
    if (!this.refreshToken) throw new CloudError('请先登录富途云端', undefined, true);
    const revision = this.revision; const refreshToken = this.refreshToken;
    const task = this.request('/oauth2/token', { body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: this.clientId }) })
      .then(data => this.accept(data, revision)).catch(async error => {
        if (revision === this.revision && error instanceof CloudError && error.loginRequired) await this.logout();
        throw error;
      }).finally(() => { if (this.pendingRefresh === task) this.pendingRefresh = undefined; });
    this.pendingRefresh = task; return task;
  }
  async logout(): Promise<void> {
    this.cancelLogin(); this.revision++; this.pendingRefresh = undefined;
    this.accessToken = ''; this.refreshToken = ''; this.expiresAt = 0; this.encryptedRefresh = undefined; this.remembered = false;
    this.message = '已退出云端登录，本机授权凭证已移除'; await this.save(); this.publish();
  }
  stop(): void { this.cancelLogin(); this.revision++; this.accessToken = ''; this.refreshToken = ''; }
}
