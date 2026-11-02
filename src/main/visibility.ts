export interface FullscreenSample { monitor: string; fullscreenMonitors: string[] }
export function parseFullscreenSample(value: unknown): FullscreenSample {
  if (!value || typeof value !== 'object') throw new Error('Invalid fullscreen sample');
  const sample = value as Record<string, unknown>;
  if (typeof sample.monitor !== 'string' || !/^\d+$/.test(sample.monitor)
    || !Array.isArray(sample.fullscreenMonitors) || sample.fullscreenMonitors.length > 64
    || !sample.fullscreenMonitors.every(id => typeof id === 'string' && /^\d+$/.test(id))) throw new Error('Invalid fullscreen sample');
  return sample as unknown as FullscreenSample;
}

/** User intent survives automatic hiding. Only this controller changes bar visibility. */
export class BarVisibility {
  private manualHidden = false;
  private fullscreen = false;
  private ready = false;
  private visible = false;
  constructor(private readonly change: (visible: boolean) => void) {}
  setReady() { this.ready = true; this.update(); }
  setSample(sample: FullscreenSample) { this.fullscreen = sample.fullscreenMonitors.includes(sample.monitor); this.update(); }
  unavailable() { this.fullscreen = false; this.update(); }
  hide() { this.manualHidden = true; this.update(); }
  restore() { this.manualHidden = false; this.update(); }
  snapshot() { return { manualHidden: this.manualHidden, fullscreen: this.fullscreen, visible: this.visible }; }
  private update() {
    const visible = this.ready && !this.manualHidden && !this.fullscreen;
    if (visible !== this.visible) { this.visible = visible; this.change(visible); }
  }
}
