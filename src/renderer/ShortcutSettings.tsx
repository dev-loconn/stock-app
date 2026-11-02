import { useEffect, useRef, useState } from 'react';
import type { StockState } from '../shared/stock';
import { DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS, SHORTCUT_LABELS, validateShortcuts, type ShortcutAction, type ShortcutBindings } from '../shared/shortcuts';

export function ShortcutSettings({ state }: { state?: StockState }) {
  const [draft, setDraft] = useState<ShortcutBindings>(structuredClone(DEFAULT_SHORTCUTS));
  const [recording, setRecording] = useState<ShortcutAction>();
  const current = useRef<ShortcutAction | undefined>(undefined);
  const loaded = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  useEffect(() => {
    if (state && !loaded.current) { loaded.current = true; setDraft(structuredClone(state.preferences.shortcuts)); }
  }, [state]);
  const endRecording = async () => {
    current.current = undefined; setRecording(undefined);
    const result = await window.stockBar.captureShortcut(false);
    if (!result.ok) throw Error(result.message);
  };
  useEffect(() => {
    const remove = window.stockBar.onShortcutCapture(value => {
      const action = current.current;
      if (!action) return;
      if (value.cancelled) { current.current = undefined; setRecording(undefined); setMessage(value.message || '已取消本次录入'); return; }
      if (value.message) { setError(true); setMessage(value.message); return; }
      if (value.accelerator) {
        setDraft(previous => ({ ...previous, [action]: value.accelerator! }));
        setMessage('组合已录入，点击保存后生效'); setError(false);
        void endRecording().catch(error => { setError(true); setMessage(error.message); });
      }
    });
    const blur = () => { if (current.current) void endRecording().catch(() => undefined); };
    window.addEventListener('blur', blur);
    return () => { remove(); window.removeEventListener('blur', blur); if (current.current) void window.stockBar.captureShortcut(false); };
  }, []);
  const task = async (run: () => Promise<void>) => {
    setBusy(true); setMessage(''); setError(false);
    try { await run(); } catch (error) { setError(true); setMessage(error instanceof Error ? error.message : '快捷键操作失败'); }
    finally { setBusy(false); }
  };
  const record = async (action: ShortcutAction) => {
    if (current.current === action) return;
    if (current.current) await endRecording();
    current.current = action; setRecording(action);
    const result = await window.stockBar.captureShortcut(true);
    if (!result.ok) { current.current = undefined; setRecording(undefined); throw Error(result.message); }
    setMessage('请按组合键；Esc 或切换窗口取消录入');
  };
  return <section className="shortcut-settings" aria-label="全局快捷键设置"><h2>全局快捷键</h2>
    <p className="muted">点击组合键录入。至少包含 Ctrl、Alt、Shift 中两个，主键支持字母、数字、方向键及 F1–F11。按住只执行一次；全屏自动隐藏期间不执行。</p>
    <div className="shortcut-list">{SHORTCUT_ACTIONS.map(action => <div className="shortcut-row" key={action}>
      <label htmlFor={`shortcut-${action}`}>{SHORTCUT_LABELS[action]}</label>
      <input id={`shortcut-${action}`} aria-label={`${SHORTCUT_LABELS[action]}快捷键`} readOnly
        value={recording === action ? '请按组合键…' : draft[action] || '已禁用'} disabled={!state || busy && recording !== action}
        className={recording === action ? 'recording' : ''}
        onClick={() => void task(() => record(action))}
        onBlur={() => { if (current.current === action) void endRecording().catch(() => undefined); }}
        onKeyDown={event => {
          if (event.key === 'Escape' && recording) { event.preventDefault(); void endRecording().catch(() => undefined); }
          else if (!recording && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); void task(() => record(action)); }
        }} />
      <button className="shortcut-secondary" disabled={!state || busy || !!recording || draft[action] === null}
        onClick={() => setDraft(value => ({ ...value, [action]: null }))}>禁用</button>
      <span className={`shortcut-status ${state?.shortcuts?.[action]?.message && state.preferences.shortcuts[action] ? 'search-error' : ''}`}>
        {state && draft[action] !== state.preferences.shortcuts[action]
          ? `未保存；当前${state.preferences.shortcuts[action] || '已禁用'}${state.shortcuts?.[action]?.active ? ' 已生效' : ''}`
          : state?.shortcuts?.[action]?.active ? '已生效' : state?.shortcuts?.[action]?.message || '未注册'}
      </span>
    </div>)}</div>
    <div className="setting-actions">
      <button disabled={!state || busy || !!recording} onClick={() => void task(async () => {
        const bindings = validateShortcuts(draft);
        const result = await window.stockBar.saveShortcuts(bindings);
        if (!result.ok) throw Error(result.message); setDraft(bindings); setMessage('快捷键已保存并生效');
      })}>保存快捷键</button>
      <button className="shortcut-secondary" disabled={!state || busy || !!recording} onClick={() => { setDraft(structuredClone(state!.preferences.shortcuts)); setMessage('已取消尚未保存的修改'); setError(false); }}>取消修改</button>
      <button className="shortcut-secondary" disabled={!state || busy || !!recording} onClick={() => { setDraft(structuredClone(DEFAULT_SHORTCUTS)); setMessage('已填入默认组合，点击保存后生效'); setError(false); }}>恢复默认</button>
      <button className="shortcut-secondary" disabled={!state || busy || !!recording} onClick={() => void task(async () => {
        const result = await window.stockBar.retryShortcuts(); if (!result.ok) throw Error(result.message); setMessage(result.message || '已重新尝试，请查看各项状态');
      })}>重新尝试</button>
    </div>
    {message && <p className={error ? 'search-error' : 'muted'} role="status">{message}</p>}
    <p className="muted">修改、禁用及恢复默认都需保存。四项一起生效；冲突或保存失败时保留原设置。</p>
  </section>;
}
