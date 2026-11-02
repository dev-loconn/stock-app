import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SECURITY_MARKETS, type SecurityMarket, type WatchItem } from '../shared/stock';
import { validateDirectory } from './security-catalog';

export interface DirectoryProcess { (python: string, args: string[], signal: AbortSignal): Promise<string> }
export function directoryProcessError(error: { code?: string | number | null; killed?: boolean }, stderr: string): Error {
  if (error.code === 'ABORT_ERR') return Error('目录同步已取消');
  const missing = /ModuleNotFoundError|ImportError/.test(stderr) || ['ENOENT', 'EACCES', 'EPERM'].includes(String(error.code));
  let detail = '';
  try {
    const value = JSON.parse(stderr.trim().split(/\r?\n/).at(-1) || '{}');
    if (typeof value?.error === 'string' && /^[A-Za-z]{1,80}$/.test(value.error) && !['undefined', 'null'].includes(value.error)) detail = `（${value.error}）`;
  } catch { /* Never return raw third-party stderr, which may include proxy URLs. */ }
  return Error(missing ? 'AKShare 运行环境不可用，请重新解压完整程序包；开发版可运行 npm run setup:akshare'
    : error.killed ? 'AKShare 同步超时，请稍后刷新；保留已有目录' : 'AKShare 数据源访问失败，请检查网络或代理后刷新' + detail);
}
const runProcess: DirectoryProcess = (python, args, signal) => new Promise((done, reject) => {
  execFile(python, args, { windowsHide: true, signal, timeout: 600000, maxBuffer: 32 * 1024 * 1024,
    encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } }, (error, stdout, stderr) => {
    if (error) {
      reject(directoryProcessError(error, stderr));
    } else done(stdout);
  });
});

// Two lanes bound process memory and keep slower US pagination from blocking all A shares.
export class AKShareDirectory {
  private queues: Promise<unknown>[] = [Promise.resolve(), Promise.resolve()];
  private controller = new AbortController();
  constructor(private root: string, private run: DirectoryProcess = runProcess,
    private options: { requireBundled?: boolean } = {}) {}
  fetch(market: SecurityMarket): Promise<WatchItem[]> {
    if (!SECURITY_MARKETS.includes(market)) return Promise.reject(Error('同步市场无效'));
    const lane = market === 'US' ? 1 : 0;
    const task = this.queues[lane].catch(() => undefined).then(async () => {
      if (this.controller.signal.aborted) throw Error('目录同步已取消');
      const local = join(this.root, '.cache', 'akshare-venv', 'Scripts', 'python.exe');
      const bundled = join(this.root, 'runtime', 'python', 'python.exe');
      if (this.options.requireBundled && !process.env.STOCK_BAR_PYTHON && !existsSync(bundled)) {
        throw Error('程序包缺少 AKShare 内置环境，请完整解压或重新下载程序包');
      }
      const python = process.env.STOCK_BAR_PYTHON || (existsSync(bundled) ? bundled : existsSync(local) ? local : 'python');
      const output = await this.run(python, ['-u', resolve(this.root, 'scripts/akshare-directory.py'), '--market', market], this.controller.signal);
      if (this.controller.signal.aborted) throw Error('目录同步已取消');
      let envelope;
      try { envelope = JSON.parse(output); } catch { throw Error('AKShare 返回格式无效，保留已有目录'); }
      if (envelope?.version !== 1 || envelope.market !== market || envelope.source !== 'akshare') throw Error('AKShare 返回市场不匹配，保留已有目录');
      return validateDirectory(envelope.items, market);
    });
    this.queues[lane] = task;
    return task;
  }
  stop() { this.controller.abort(); }
}
