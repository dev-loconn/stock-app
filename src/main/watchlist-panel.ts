import { BrowserWindow, screen, type BrowserWindowConstructorOptions } from 'electron';
import { panelBounds } from '../shared/panel-layout';
import type { Bounds } from '../shared/panel-layout';

interface PanelOptions {
  bar: BrowserWindow;
  page: string;
  webPreferences: BrowserWindowConstructorOptions['webPreferences'];
  content: () => { rows: number; fontSize: number };
  restore: () => void;
  blocked: () => boolean;
  blockedNotice: () => void;
  secure: (window: BrowserWindow) => void;
  changed: (open: boolean) => void;
  hidden?: boolean;
}

/** Owns the transient panel; quote subscriptions remain owned by MarketService. */
export class WatchlistPanel {
  private window?: BrowserWindow;
  private requested = false;
  private activate = true;
  private ready = false;
  private lastBounds?: Bounds;
  private warmUntil = 0;
  private revealTimer?: ReturnType<typeof setTimeout>;
  constructor(private readonly options: PanelOptions) {}
  getWindow() { return this.window; }
  isOpen() { return this.requested; }
  isPresented() { return this.requested && !!this.window && !this.window.isDestroyed() && this.window.isVisible() && this.window.getOpacity() > 0; }

  open(activate = true): BrowserWindow | undefined {
    const options = this.options;
    if (options.blocked()) { this.close(); options.blockedNotice(); return; }
    options.restore();
    if (!options.bar.isVisible() && !options.hidden) return;
    this.requested = true;
    this.activate = activate;
    if (!this.window || this.window.isDestroyed()) {
      this.ready = false;
      const bounds = this.bounds();
      const window = new BrowserWindow({ ...bounds, parent: options.bar,
        // Windows otherwise retains WS_CAPTION even with frame:false. Disable its
        // border and hide/show animations for this transient, fixed-size panel.
        frame: false, thickFrame: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
        skipTaskbar: true, alwaysOnTop: true, show: false, hasShadow: false, focusable: false, opacity: 0,
        transparent: true, title: '自选行情', backgroundColor: '#00000000', webPreferences: options.webPreferences });
      this.window = window;
      // Normalize once after first paint; Windows' constructor frame size can differ from setBounds at fractional DPI.
      this.lastBounds = undefined;
      options.secure(window);
      window.once('ready-to-show', () => { this.ready = true; this.present(); });
      // Losing focus leaves the panel open and never takes focus back.
      // Explicit controls and the bar's visibility lifecycle own dismissal.
      window.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); this.close(); }
      });
      window.on('closed', () => { this.window = undefined; this.ready = false; this.close(); });
      void window.loadFile(options.page, { query: { view: 'overview' } });
    }
    options.changed(true);
    this.present();
    return this.window;
  }
  toggle(activate = true) { if (this.requested) this.close(); else this.open(activate); }
  close() {
    clearTimeout(this.revealTimer);
    if (!this.requested) return;
    this.requested = false;
    if (this.window && !this.window.isDestroyed()) {
      this.window.setOpacity(0);
      this.window.setIgnoreMouseEvents(true);
      if (this.window.isFocusable()) this.window.setFocusable(false);
      this.window.webContents.send('stock:panel-open', false);
    }
    this.options.changed(false);
  }
  reposition() {
    if (this.window && !this.window.isDestroyed()) {
      const bounds = this.bounds();
      // Compare requested DIPs, not rounded HWND bounds: otherwise every quote can resize the window at fractional DPI.
      if (!this.lastBounds || Object.keys(bounds).some(key => bounds[key as keyof Bounds] !== this.lastBounds![key as keyof Bounds])) {
        this.window.setBounds(bounds); this.lastBounds = bounds;
      }
    }
  }
  private bounds() {
    const bar = this.options.bar.getBounds();
    const work = screen.getDisplayMatching(bar).workArea;
    const { rows, fontSize } = this.options.content();
    return panelBounds(bar, work, rows, fontSize);
  }
  private present() {
    if (!this.requested || !this.ready) return;
    this.reposition();
    const window = this.window!;
    if (this.options.hidden) { window.webContents.send('stock:panel-open', true); return; }
    // Keep the transparent native surface alive. Repeated ShowWindow transitions
    // flash on Windows; opacity toggles preserve the compositor's existing surface.
    if (!window.isVisible()) {
      window.setIgnoreMouseEvents(true);
      window.showInactive();
      this.warmUntil = Date.now() + 250;
    }
    clearTimeout(this.revealTimer);
    const reveal = () => {
      if (!this.requested || window !== this.window || window.isDestroyed() || !this.options.bar.isVisible()) return;
      window.webContents.send('stock:panel-open', true);
      window.setIgnoreMouseEvents(false);
      // Keep shortcut previews non-activating for their whole lifetime. On
      // Windows, toggling a live owned window's focusability back on close can
      // deactivate the editor even when this panel never received focus.
      if (window.isFocusable() !== this.activate) window.setFocusable(this.activate);
      window.setOpacity(1);
      if (this.activate) window.focus();
    };
    const delay = Math.max(0, this.warmUntil - Date.now());
    if (delay) this.revealTimer = setTimeout(reveal, delay); else reveal();
  }
}
