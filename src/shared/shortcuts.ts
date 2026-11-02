export const SHORTCUT_ACTIONS = ['toggleBar', 'togglePanel', 'previousPage', 'nextPage'] as const;
export type ShortcutAction = typeof SHORTCUT_ACTIONS[number];
export type ShortcutBindings = Record<ShortcutAction, string | null>;
export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  toggleBar: '显示／隐藏悬浮条', togglePanel: '展开／收起行情面板', previousPage: '上一页', nextPage: '下一页',
};
export const DEFAULT_SHORTCUTS: ShortcutBindings = {
  toggleBar: 'Ctrl+Alt+H', togglePanel: 'Ctrl+Alt+Q', previousPage: 'Ctrl+Alt+J', nextPage: 'Ctrl+Alt+K',
};
/** Upgrade unchanged 0.9.0 defaults without displacing a user's custom binding. */
export function upgradeShortcutDefaults(bindings: ShortcutBindings): ShortcutBindings {
  const next = { ...bindings };
  const previous = { togglePanel: 'Ctrl+Alt+W', previousPage: 'Ctrl+Alt+Left', nextPage: 'Ctrl+Alt+Right' };
  for (const action of ['togglePanel', 'previousPage', 'nextPage'] as const) {
    if (next[action] === previous[action] && !SHORTCUT_ACTIONS.some(other => other !== action && next[other] === DEFAULT_SHORTCUTS[action])) {
      next[action] = DEFAULT_SHORTCUTS[action];
    }
  }
  return next;
}
export interface ShortcutStatus { active: boolean; message?: string }
export type ShortcutStatuses = Record<ShortcutAction, ShortcutStatus>;
export interface NativeBinding { action: ShortcutAction; modifiers: number; key: number }
export interface ShortcutCapture { accelerator?: string; cancelled?: boolean; message?: string }
export function normalizeShortcut(value: unknown): string {
  if (typeof value !== 'string' || value.length > 80) throw Error('快捷键格式无效');
  const parts = value.split('+').map(part => part.trim().toLowerCase());
  const primary = parts.pop() || '';
  if (new Set(parts).size !== parts.length || parts.length < 2 || parts.some(part => !['ctrl', 'alt', 'shift'].includes(part))) {
    throw Error('请使用 Ctrl、Alt、Shift 中至少两个修饰键，不支持 Win 键');
  }
  if (primary === 'f12') throw Error('F12 由 Windows 保留，请选择 F1–F11 或其他主键');
  const arrows: Record<string, string> = { left: 'Left', arrowleft: 'Left', right: 'Right', arrowright: 'Right',
    up: 'Up', arrowup: 'Up', down: 'Down', arrowdown: 'Down' };
  const key = /^[a-z0-9]$/.test(primary) ? primary.toUpperCase() : arrows[primary]
    || (/^f(?:[1-9]|10|11)$/.test(primary) ? primary.toUpperCase() : '');
  if (!key) throw Error('主键支持字母、数字、方向键和 F1–F11');
  return [...(['ctrl', 'alt', 'shift'] as const).filter(part => parts.includes(part)).map(part => ({ ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' })[part]), key].join('+');
}
export function validateShortcuts(value: unknown): ShortcutBindings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('快捷键设置无效');
  const data = value as Record<string, unknown>;
  const bindings = {} as ShortcutBindings;
  const seen = new Set<string>();
  for (const action of SHORTCUT_ACTIONS) {
    const key = data[action] === null ? null : normalizeShortcut(data[action]);
    if (key && seen.has(key)) throw Error('不同操作不能使用相同的快捷键');
    if (key) seen.add(key);
    bindings[action] = key;
  }
  return bindings;
}
export function nativeBindings(bindings: ShortcutBindings): NativeBinding[] {
  return SHORTCUT_ACTIONS.flatMap(action => {
    const accelerator = bindings[action];
    if (!accelerator) return [];
    const parts = accelerator.split('+'); const key = parts.pop()!;
    const modifiers = (parts.includes('Ctrl') ? 2 : 0) | (parts.includes('Alt') ? 1 : 0) | (parts.includes('Shift') ? 4 : 0);
    const arrows: Record<string, number> = { Left: 37, Up: 38, Right: 39, Down: 40 };
    return [{ action, modifiers, key: arrows[key] || (key.length > 1 ? 111 + Number(key.slice(1)) : key.charCodeAt(0)) }];
  });
}
export function acceleratorFromNative(modifiers: number, key: number): string {
  if (modifiers & ~7) throw Error('首版不支持 Win 键组合');
  const names: Record<number, string> = { 37: 'Left', 38: 'Up', 39: 'Right', 40: 'Down' };
  const primary = names[key] || (key >= 112 && key <= 123 ? `F${key - 111}` : String.fromCharCode(key));
  return normalizeShortcut([...(modifiers & 2 ? ['Ctrl'] : []), ...(modifiers & 1 ? ['Alt'] : []), ...(modifiers & 4 ? ['Shift'] : []), primary].join('+'));
}
