import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const parseNum = (s) => {
  const t = String(s ?? '').replace(/[$,\s]/g, '');
  if (t === '') return null;
  const neg = /^\(.*\)$/.test(t);
  const n = Number(t.replace(/[()]/g, ''));
  return Number.isFinite(n) ? (neg ? -n : n) : NaN;
};

/**
 * Inline worksheet cell. Shows the formatted value; edits the raw value.
 * Saves on Enter / blur. If the save fails the typed value stays in the cell,
 * outlined red, until it is saved (Retry) or reverted with Escape.
 */
export function WsCell({ value, onSave, type = 'text', format, className = '', title, placeholder, disabled, ariaLabel, wrap, autoFocus }) {
  const [draft, setDraft] = useState(null);
  const [focus, setFocus] = useState(false);
  const [state, setState] = useState(null); // null | 'saving' | 'error'
  const [error, setError] = useState(null);
  const raw = value == null ? '' : type === 'number' ? String(+Number(value).toFixed(6)) : String(value);
  useEffect(() => { if (state !== 'error' && state !== 'saving') setDraft(null); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (next) => {
    setState('saving'); setError(null);
    try { await onSave(next); setState(null); setDraft(null); } catch (e) { setState('error'); setError(e.message); }
  };
  // Back to the saved value: nothing to save, unless an earlier attempt failed —
  // then confirm the saved value so the "not saved" warning clears.
  const revert = () => { const failed = state === 'error'; setDraft(null); setState(null); setError(null); if (failed) save(value ?? (type === 'number' ? null : '')); };

  const commit = async () => {
    if (draft == null || state === 'saving') return;
    let next = draft;
    if (type === 'number') {
      next = parseNum(draft);
      if (Number.isNaN(next)) { setState('error'); setError('Enter a number'); return; }
      const prev = value == null ? null : Number(value);
      if (next === prev || (next != null && prev != null && Math.abs(next - prev) < 1e-9)) { revert(); return; }
    } else if (next === (value ?? '')) { revert(); return; }
    save(next);
  };

  const shown = draft != null ? draft : focus ? raw : format ? format(value) : raw;
  // wrap: a textarea that keeps the column width and grows downward to fit the text
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current; if (!wrap || !el) return undefined;
    let width = -1;
    const fit = () => { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; };
    fit();
    const ro = new ResizeObserver(([e]) => { if (e.contentRect.width !== width) { width = e.contentRect.width; fit(); } }); // re-wrap when the column width changes
    ro.observe(el);
    return () => ro.disconnect();
  }, [wrap, shown]);
  useEffect(() => { if (autoFocus && ref.current) { ref.current.focus(); ref.current.scrollIntoView({ block: 'center' }); } }, [autoFocus]);
  const Tag = wrap ? 'textarea' : 'input';
  return (
    <Tag
      ref={ref}
      rows={wrap ? 1 : undefined}
      aria-label={ariaLabel}
      className={`ws-cell ${type === 'number' ? 'num' : ''} ${wrap ? 'wrap' : ''} ${state ? `is-${state}` : ''} ${className}`}
      value={shown}
      placeholder={placeholder}
      title={error ? `Not saved: ${error} — press Enter to retry, Esc to undo` : title}
      disabled={disabled}
      inputMode={type === 'number' ? 'decimal' : undefined}
      onFocus={(e) => { setFocus(true); const t = e.target; requestAnimationFrame(() => (wrap ? t.setSelectionRange(t.value.length, t.value.length) : t.select())); }}
      onChange={(e) => setDraft(wrap ? e.target.value.replace(/\n/g, ' ') : e.target.value)}
      onBlur={() => { setFocus(false); commit(); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } // blur saves
        if (e.key === 'Escape') { revert(); setTimeout(() => e.target.blur()); }
      }}
    />
  );
}

export const STATUS_LABEL = { proposed: 'Proposed', pending: 'Pending', accepted: 'Accepted', rejected: 'Rejected', excluded: 'Excluded' };

export function StatusPill({ status }) {
  return <span className={`st st-${status}`}>{STATUS_LABEL[status] || status}</span>;
}

/** Signed currency for the VE column: −$1,234.00 for deducts, +$1,234.00 for adds. */
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
export const signed = (v) => (v == null ? '' : Math.abs(v) < 0.005 ? '$0.00' : `${v < 0 ? '−' : '+'}${usd.format(Math.abs(v))}`);
export const cur = (v) => (v == null ? '' : `${v < 0 ? '−' : ''}${usd.format(Math.abs(v))}`);
export const qtyFmt = (v) => (v == null ? '' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(v));
export const toCents = (v) => Math.round((Number(v) || 0) * 100);

// Excel accounting style, as in the MC Aquatic bid template: the "$" sits at the left edge of
// the cell (drawn by the .acct wrapper), the amount at the right, "-" for zero and
// negatives in parentheses.
const acctNum = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const acct = (v) => (v == null || v === '' ? '' : Math.abs(v) < 0.005 ? '-' : v < 0 ? `(${acctNum.format(-v)})` : acctNum.format(v));

/** A money value shown in accounting style (read-only). */
export function Acct({ value, className = '', title }) {
  return <span className={`acct ${value == null ? 'is-empty' : ''} ${className}`} title={title}><span className="acct-v">{acct(value)}</span></span>;
}
