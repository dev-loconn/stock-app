import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { acceleratorFromNative, nativeBindings, SHORTCUT_ACTIONS, SHORTCUT_LABELS, validateShortcuts,
  type ShortcutAction, type ShortcutBindings, type ShortcutCapture, type ShortcutStatuses } from '../shared/shortcuts';

export interface NativeReply {
  ok: boolean; message?: string;
  statuses?: { action: ShortcutAction; active: boolean }[];
  failures?: { action: ShortcutAction; error: number }[];
}
export interface NativeEvent { eventType: string; action?: ShortcutAction; modifiers?: number; key?: number; cancelled?: boolean }
export interface ShortcutTransport {
  start(): Promise<void>;
  request(operation: string, input?: Record<string, unknown>): Promise<NativeReply>;
  stop(): void;
}
/** One owner for native registrations. A failed helper stays failed until explicit retry. */
export class NativeShortcuts implements ShortcutTransport {
  private child?: ChildProcessWithoutNullStreams;
  private serial = 0;
  private starting?: Promise<void>;
  private pending = new Map<number, { resolve: (reply: NativeReply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private executable: string, private event: (event: NativeEvent) => void, private unavailable: () => void) {}
  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.child) return Promise.resolve();
    this.starting = new Promise<void>((resolve, reject) => {
      const child = spawn(this.executable, [String(process.pid)], { windowsHide: true, stdio: 'pipe' });
      this.child = child;
      const timeout = setTimeout(() => { reject(Error('快捷键服务启动超时')); child.kill(); }, 5000);
      const lines = createInterface({ input: child.stdout });
      child.stderr.resume();
      lines.on('line', line => {
        if (this.child !== child) return;
        try {
          const value = JSON.parse(line);
          if (value.eventType === 'ready') { clearTimeout(timeout); resolve(); }
          else if (typeof value.id === 'number') {
            const pending = this.pending.get(value.id);
            if (pending) { this.pending.delete(value.id); clearTimeout(pending.timer); pending.resolve(value); }
          } else this.event(value);
        } catch { child.kill(); }
      });
      let ended = false;
      const end = () => {
        if (ended) return; ended = true; clearTimeout(timeout); lines.close(); reject(Error('快捷键服务不可用，请重新尝试'));
        if (this.child !== child) return;
        this.child = undefined;
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(Error('快捷键服务不可用，请重新尝试')); }
        this.pending.clear(); this.unavailable();
      };
      child.on('error', end); child.on('exit', end); child.stdin.on('error', end);
    }).finally(() => { this.starting = undefined; });
    return this.starting;
  }
  request(operation: string, input: Record<string, unknown> = {}): Promise<NativeReply> {
    const child = this.child;
    if (!child) return Promise.reject(Error('快捷键服务不可用，请重新尝试'));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error('快捷键服务响应超时')); child.kill(); }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, operation, ...input }) + '\n');
    });
  }
  stop() { this.child?.stdin.end(); }
}

export class ShortcutManager {
  private transport: ShortcutTransport;
  private busy = false;
  private capturing = false;
  private available = false;
  private statuses = {} as ShortcutStatuses;
  constructor(private bindings: ShortcutBindings,
    factory: (event: (value: NativeEvent) => void, unavailable: () => void) => ShortcutTransport,
    private action: (action: ShortcutAction) => void,
    private capture: (capture: ShortcutCapture) => void,
    private changed: () => void) {
    this.transport = factory(value => this.handle(value), () => {
      this.available = false; this.capturing = false;
      this.capture({ cancelled: true, message: '快捷键服务不可用，请重新尝试' });
      this.setStatuses();
    });
    this.setStatuses();
  }
  snapshot(): ShortcutStatuses { return structuredClone(this.statuses); }
  private setStatuses(reply?: NativeReply) {
    for (const action of SHORTCUT_ACTIONS) {
      const active = reply?.statuses?.some(status => status.action === action && status.active) || false;
      const error = reply?.failures?.find(failure => failure.action === action)?.error;
      this.statuses[action] = { active, message: !this.bindings[action] ? '已禁用' : active ? undefined
        : error ? `组合被占用或无法注册（Windows ${error}），请改键或重新尝试` : '快捷键服务不可用，请重新尝试' };
    }
    this.changed();
  }
  private handle(value: NativeEvent) {
    if (value.eventType === 'capture' && this.capturing) {
      if (value.cancelled) { this.capturing = false; this.capture({ cancelled: true }); return; }
      try { this.capture({ accelerator: acceleratorFromNative(Number(value.modifiers), Number(value.key)) }); }
      catch (error) { this.capture({ message: error instanceof Error ? error.message : '组合无效' }); }
    } else if (value.eventType === 'action' && !this.busy && !this.capturing && this.available
      && SHORTCUT_ACTIONS.includes(value.action!) && this.statuses[value.action!]?.active) this.action(value.action!);
  }
  async retry() {
    if (this.busy || this.capturing) throw Error('请先完成当前快捷键操作');
    this.busy = true;
    try {
      await this.transport.start();
      const reply = await this.transport.request('sync', { bindings: nativeBindings(this.bindings) });
      if (!reply.ok) throw Error(reply.message || '快捷键注册失败');
      this.available = true; this.setStatuses(reply);
    } finally { this.busy = false; }
  }
  async record(active: boolean, window = '0') {
    if (active && (this.busy || !this.available)) throw Error('快捷键服务未就绪，请重新尝试');
    // Stop action dispatch before asking the native process to install capture.
    if (active) this.capturing = true;
    try {
      const reply = await this.transport.request('capture', { active, window });
      if (!reply.ok) throw Error(reply.message || '无法录入快捷键');
    } catch (error) { this.capturing = false; throw error; }
    this.capturing = active;
  }
  async cancelRecording() {
    if (!this.capturing) return;
    await this.record(false);
    this.capture({ cancelled: true });
  }
  async save(input: unknown, persist: (bindings: ShortcutBindings) => Promise<void>) {
    const bindings = validateShortcuts(input);
    if (this.busy || this.capturing) throw Error('请先结束快捷键录入');
    if (!this.available) throw Error('快捷键服务未就绪，请重新尝试');
    this.busy = true;
    const previous = this.bindings;
    let persisted = false;
    try {
      const prepared = await this.transport.request('prepare', { bindings: nativeBindings(bindings) });
      if (!prepared.ok) {
        const failures = prepared.failures?.map(failure => `${SHORTCUT_LABELS[failure.action]}（Windows ${failure.error}）`).join('、');
        throw Error(failures ? `${failures} 的组合被占用或无法注册，原设置保留` : prepared.message || '快捷键注册失败');
      }
      await persist(bindings); persisted = true;
      const committed = await this.transport.request('commit');
      if (!committed.ok) throw Error('快捷键生效失败');
      this.bindings = bindings; this.setStatuses(committed);
    } catch (error) {
      if (persisted) {
        try { await persist(previous); }
        catch { throw Error('快捷键服务中断且旧配置恢复失败，请检查设置文件后重启'); }
      }
      await this.transport.request('rollback').catch(() => undefined);
      throw error;
    } finally { this.busy = false; }
  }
  stop() { this.transport.stop(); }
}
