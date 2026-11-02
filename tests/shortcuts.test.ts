import { expect, it } from 'vitest';
import { DEFAULT_SHORTCUTS, nativeBindings, normalizeShortcut, validateShortcuts } from '../src/shared/shortcuts';
import { ShortcutManager, type NativeReply, type ShortcutTransport } from '../src/main/shortcuts';

it('normalizes equivalent keys and rejects duplicate, unsupported and reserved combinations', () => {
  expect(normalizeShortcut('shift+alt+ctrl+arrowleft')).toBe('Ctrl+Alt+Shift+Left');
  expect(normalizeShortcut('alt+ctrl+h')).toBe(DEFAULT_SHORTCUTS.toggleBar);
  for (const key of ['Ctrl+H', 'Ctrl+Ctrl+H', 'Ctrl+Win+H', 'Ctrl+Alt+F12', 'Ctrl+Alt+Space']) expect(() => normalizeShortcut(key)).toThrow();
  expect(() => validateShortcuts({ ...DEFAULT_SHORTCUTS, togglePanel: 'alt+ctrl+h' })).toThrow('相同');
  expect(validateShortcuts({ ...DEFAULT_SHORTCUTS, toggleBar: null }).toggleBar).toBeNull();
  expect(nativeBindings(DEFAULT_SHORTCUTS)[2]).toEqual({ action: 'previousPage', modifiers: 3, key: 74 });
});

function fixture() {
  const calls: string[] = [];
  let failPrepare = false, persisted = 0, staged = false;
  const transport: ShortcutTransport = {
    start: async () => {}, stop: () => {},
    request: async operation => {
      calls.push(operation);
      if (operation === 'prepare') { staged = !failPrepare; return { ok: !failPrepare, failures: failPrepare ? [{ action: 'toggleBar', error: 1409 }] : [] }; }
      if (operation === 'rollback') staged = false;
      if (operation === 'commit') { if (!staged) throw Error('not prepared'); staged = false; }
      return { ok: true, statuses: [{ action: 'toggleBar', active: true }, { action: 'togglePanel', active: true }] } satisfies NativeReply;
    },
  };
  const manager = new ShortcutManager({ ...DEFAULT_SHORTCUTS }, () => transport, () => {}, () => {}, () => {});
  return { manager, calls, conflict: () => { failPrepare = true; }, persist: async () => { persisted++; }, count: () => persisted };
}

it('keeps the old group when native preparation fails and does not persist a partial group', async () => {
  const f = fixture(); await f.manager.retry(); f.conflict();
  await expect(f.manager.save({ ...DEFAULT_SHORTCUTS, toggleBar: 'Ctrl+Shift+H' }, f.persist)).rejects.toThrow('原设置保留');
  expect(f.count()).toBe(0); expect(f.calls).not.toContain('commit');
  expect(f.manager.snapshot().toggleBar.active).toBe(true);
});

it('rolls back native preparation after a disk failure and allows the next edit', async () => {
  const f = fixture(); await f.manager.retry();
  await expect(f.manager.save({ ...DEFAULT_SHORTCUTS, toggleBar: null }, async () => { throw Error('disk full'); })).rejects.toThrow('disk full');
  expect(f.calls.slice(-2)).toEqual(['prepare', 'rollback']);
  await f.manager.save({ ...DEFAULT_SHORTCUTS, toggleBar: null }, f.persist);
  expect(f.count()).toBe(1); expect(f.calls.slice(-2)).toEqual(['prepare', 'commit']);
});

it('ignores action messages during recording and refuses overlapping edits', async () => {
  let event: ((value: { eventType: string; action: 'toggleBar' }) => void) | undefined;
  let actions = 0;
  const f = fixture();
  const transport: ShortcutTransport = { start: async () => {}, stop: () => {}, request: async () => ({ ok: true, statuses: [{ action: 'toggleBar', active: true }] }) };
  const manager = new ShortcutManager({ ...DEFAULT_SHORTCUTS }, handler => { event = handler; return transport; }, () => { actions++; }, () => {}, () => {});
  await manager.retry(); await manager.record(true, '1');
  event!({ eventType: 'action', action: 'toggleBar' });
  await expect(manager.save(DEFAULT_SHORTCUTS, f.persist)).rejects.toThrow('录入');
  expect(actions).toBe(0);
  await manager.record(false); event!({ eventType: 'action', action: 'toggleBar' }); expect(actions).toBe(1);
});
