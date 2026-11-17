import { useEffect, useRef, useState } from 'react';
import { TYPE_NAMES } from '../util';

/** Input that saves on blur / Enter (only when the value changed). */
export function EditCell({ value, onSave, type = 'text', className = '', placeholder, step, width, title, multiline }) {
  const [v, setV] = useState(value ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setV(value ?? ''); }, [value]);
  const commit = async () => {
    const next = type === 'number' ? (v === '' ? null : Number(v)) : v;
    const prev = type === 'number' ? (value === '' || value == null ? null : Number(value)) : (value ?? '');
    if (next === prev) return;
    setBusy(true);
    try { await onSave(next); } catch (e) { alert(e.message); setV(value ?? ''); } finally { setBusy(false); }
  };
  const props = {
    value: v, placeholder, title, step,
    className: `cell ${type === 'number' ? 'num' : ''} ${busy ? 'busy' : ''} ${className}`,
    style: width ? { width } : undefined,
    onChange: (e) => setV(e.target.value),
    onBlur: commit,
    onKeyDown: (e) => {
      if (e.key === 'Enter' && !multiline) e.currentTarget.blur();
      if (e.key === 'Escape') { setV(value ?? ''); setTimeout(() => e.target.blur()); }
    },
  };
  return multiline ? <textarea rows={4} {...props} /> : <input type={type === 'number' ? 'number' : 'text'} {...props} />;
}

export function Select({ value, onChange, options, className = '', placeholder }) {
  return (
    <select className={`cell ${className}`} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function Modal({ title, onClose, children, wide }) {
  const ref = useRef();
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} ref={ref}>
        <div className="modal-head"><h3>{title}</h3><button className="ghost" onClick={onClose}>✕</button></div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, children, hint }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function TypeBadge({ t }) {
  return <span className={`badge t-${t}`} title={TYPE_NAMES[t]}>{t}</span>;
}

export function ErrorBox({ error }) {
  return error ? <div className="error">{error}</div> : null;
}
