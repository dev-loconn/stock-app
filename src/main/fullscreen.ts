import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { parseFullscreenSample, type FullscreenSample } from './visibility';

/** One small native process; no PowerShell or native Node ABI dependency at runtime. */
export class FullscreenWatcher {
  private child?: ChildProcess;
  private retry?: ReturnType<typeof setTimeout>;
  private health?: ReturnType<typeof setInterval>;
  private lastSample = 0;
  private stopped = true;
  constructor(private readonly executable: string, private readonly handle: Buffer,
    private readonly sample: (sample: FullscreenSample) => void, private readonly unavailable: () => void) {}
  start() { if (!this.stopped) return; this.stopped = false; this.launch(); }
  stop() {
    this.stopped = true; clearTimeout(this.retry); clearInterval(this.health);
    const child = this.child; this.child = undefined; child?.kill();
  }
  private launch() {
    if (this.stopped) return;
    const handle = this.handle.length === 8 ? this.handle.readBigUInt64LE().toString() : this.handle.readUInt32LE().toString();
    const diagnostics = process.argv.includes('--fullscreen-check') || process.argv.includes('--fullscreen-live-check');
    const child = spawn(this.executable, [handle, String(process.pid), ...(diagnostics ? ['--diagnostics'] : [])], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr?.on('data', data => { if (diagnostics) console.error(String(data).trim()); });
    this.child = child; this.lastSample = Date.now();
    const lines = createInterface({ input: child.stdout! });
    lines.on('line', line => {
      if (this.child !== child || this.stopped) return;
      try { const value = parseFullscreenSample(JSON.parse(line)); this.lastSample = Date.now(); this.sample(value); } catch { this.unavailable(); }
    });
    let ended = false;
    const end = () => {
      if (ended) return; ended = true; lines.close();
      if (this.child !== child || this.stopped) return;
      this.child = undefined; clearInterval(this.health); this.unavailable();
      this.retry = setTimeout(() => this.launch(), 5000);
    };
    child.once('error', end); child.once('exit', end);
    this.health = setInterval(() => { if (Date.now() - this.lastSample > 3000) { this.unavailable(); child.kill(); } }, 1000);
  }
}
