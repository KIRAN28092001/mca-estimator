import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../../api';
import { TYPES, TYPE_NAMES } from '../../../util';
import { cur, qtyFmt } from './cells.jsx';

const parseNum = (v) => { const t = String(v ?? '').replace(/[$,\s]/g, ''); return t === '' ? null : Number(t); };
const compact = (s) => s.toLowerCase().replace(/[\s.-]/g, '');

function CostTypeLine({ value, onChange, disabled = false, includeAll = false, label = 'Cost classification' }) {
  const choices = includeAll ? [['all', 'All costs'], ...TYPES.map((t) => [t, TYPE_NAMES[t]])] : TYPES.map((t) => [t, TYPE_NAMES[t]]);
  return (
    <div className={`cost-type-line${disabled ? ' is-disabled' : ''}`} role="group" aria-label={label}>
      {choices.map(([code, name]) => (
        <button key={code} type="button" className={`cost-type type-${code.toLowerCase()}${value === code ? ' is-active' : ''}`}
          aria-pressed={value === code} disabled={disabled} onClick={() => onChange(code)}>
          {code !== 'all' && <span className="cost-type-code">{code}</span>}{name}
        </button>
      ))}
    </div>
  );
}

/**
 * Always-visible item entry (ProEst-style): search the item database, pick a material / labor /
 * equipment / subcontract / other line, choose the parent bid item, enter qty and cost, add.
 * The panel stays put so many components can be added in a row.
 */
export default function ItemEntryPanel({ est, items, saver, onAdded }) {
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [type, setType] = useState('all');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [sel, setSel] = useState(null);
  const [f, setF] = useState({ label: '', cost_type: 'M', qty: '', unit: '', unit_cost: '' });
  const [parent, setParent] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const searchRef = useRef(null);
  const qtyRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => { const t = setTimeout(() => setDq(q), 150); return () => clearTimeout(t); }, [q]); // debounce

  // Parent bid items of this estimate (base items in worksheet order, then items priced inside alternates)
  // Bid items grouped by section ("1 – POOL" › "1.1 – Pool Excavation"), then items priced inside alternates
  const groups = useMemo(() => {
    const byId = new Map(est.items.map((i) => [i.id, i]));
    const short = (t) => (t.length > 70 ? `${t.slice(0, 69).trimEnd()}…` : t); // option text can't wrap
    const label = (i, no) => `${no} – ${short(i.name.trim() || '(no description yet)')}${est.areas.length > 1 ? ` [${i.area_tag}]` : ''}`;
    const out = est.sections.map((s) => ({ label: `${s.number} – ${s.name}`, items: s.item_ids.map((id) => byId.get(id)).map((i) => ({ id: i.id, label: label(i, i.number) })) }));
    const altItems = est.items.filter((i) => i.alternate_id);
    if (altItems.length) out.push({ label: 'Priced inside alternates', items: altItems.map((i) => ({ id: i.id, label: label(i, i.number) })) });
    return out.filter((g) => g.items.length);
  }, [est]);
  const parents = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  useEffect(() => { if (parent && !parents.some((p) => p.id === Number(parent))) setParent(''); }, [parents, parent]);

  const results = useMemo(() => {
    const tokens = dq.toLowerCase().split(/\s+/).filter(Boolean);
    if (!items || (!tokens.length && type === 'all')) return [];
    return items.filter((i) => {
      if (!i.active || (type !== 'all' && i.cost_type !== type)) return false;
      const hay = [i.item_code, i.description, i.cost_code, i.cost_code_name, i.unit, TYPE_NAMES[i.cost_type], i.notes].join(' ').toLowerCase();
      const hayC = compact(hay);
      return tokens.every((t) => hay.includes(t) || hayC.includes(compact(t)));
    }).slice(0, 50);
  }, [items, dq, type]);
  useEffect(() => { setHi(0); }, [dq, type]);
  useEffect(() => { listRef.current?.querySelector('.is-hi')?.scrollIntoView({ block: 'nearest' }); }, [hi]);

  const choose = (it) => {
    setSel(it); setOpen(false); setQ(`${it.item_code} ${it.description}`); setMsg(null);
    setF({ label: it.description, cost_type: it.cost_type, qty: '', unit: it.unit, unit_cost: String(it.unit_cost) });
  };
  // Once an item is chosen (and the fields are enabled), the cursor goes to Quantity
  useLayoutEffect(() => { if (sel) qtyRef.current?.focus(); }, [sel]); // before paint, so fast typing lands in Quantity
  const qty = parseNum(f.qty), unitCost = parseNum(f.unit_cost);
  const ext = Number.isFinite(qty) && Number.isFinite(unitCost) && qty != null && unitCost != null ? Math.round(qty * unitCost * 100) / 100 : null;

  const add = async () => {
    const err = !sel ? 'Search and select a database item first.'
      : !parent ? 'Select the bid item this component belongs to (ASSIGN TO BID ITEM).'
        : qty == null || !Number.isFinite(qty) || qty <= 0 ? 'Enter a quantity greater than zero.'
          : unitCost == null || !Number.isFinite(unitCost) || unitCost < 0 ? 'Enter a unit cost of zero or more.'
            : !String(f.unit).trim() ? 'Enter a unit of measure.'
              : !String(f.label).trim() ? 'Enter a description.' : null;
    if (err) { setMsg({ kind: 'error', text: err }); return; }
    const p = parents.find((x) => x.id === Number(parent));
    setBusy(true);
    let created;
    try {
      await saver.run(`Add ${f.label} to ${p.label}`,
        async () => { created = await api.post(`/estimate-items/${parent}/components`, { item_id: sel.id, label: f.label.trim(), cost_type: f.cost_type, qty, unit: f.unit.trim(), unit_cost: unitCost }); },
        () => api.del(`/components/${created.id}`));
      setMsg({ kind: 'ok', text: `Added ${f.label} (${qtyFmt(qty)} ${f.unit} × ${cur(unitCost)} = ${cur(ext)}) to ${p.label}.` });
      onAdded?.(Number(parent));
      // Ready for the next entry: keep the bid item and type filter, clear the item fields
      setSel(null); setQ(''); setDq(''); setF({ label: '', cost_type: 'M', qty: '', unit: '', unit_cost: '' });
      searchRef.current?.focus();
    } catch (e) { setMsg({ kind: 'error', text: `Not added: ${e.message}` }); } finally { setBusy(false); }
  };

  const onSearchKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((i) => Math.min(results.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter' && results[hi] && open) { e.preventDefault(); choose(results[hi]); }
    else if (e.key === 'Escape') setOpen(false);
  };
  const onFieldKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };

  return (
    <section className="entry" aria-label="Item entry">
      <div className="entry-title">ITEM ENTRY <span>Search the database, choose the bid item, enter quantity and cost, then add.</span></div>
      <div className="entry-search">
        <div className="entry-q">
          <input ref={searchRef} value={q} placeholder="Search database: item no., description, cost code, material, labor, equipment, subcontractor, category…"
            aria-label="Search the item database" onChange={(e) => { setQ(e.target.value); setSel(null); setOpen(true); }} onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)} onKeyDown={onSearchKey} />
          {open && !sel && (dq || type !== 'all') && (
            <div className="entry-results" ref={listRef} role="listbox">
              {!results.length ? <div className="entry-none">No database items match “{dq}”.</div> : (
                <table>
                  <thead><tr><th>Item No.</th><th>Description</th><th>Cost Code</th><th>Cost Type</th><th>Unit</th><th className="num">Unit Cost</th></tr></thead>
                  <tbody>
                    {results.map((it, i) => (
                      <tr key={it.id} className={i === hi ? 'is-hi' : ''} onMouseDown={(e) => { e.preventDefault(); choose(it); }} onMouseEnter={() => setHi(i)} role="option" aria-selected={i === hi}>
                        <td className="mono">{it.item_code}</td><td>{it.description}</td><td className="mono">{it.cost_code || '—'}</td>
                        <td><span className={`type-mark type-${it.cost_type.toLowerCase()}`}>{it.cost_type} · {TYPE_NAMES[it.cost_type]}</span></td><td>{it.unit}</td><td className="num">{cur(it.unit_cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
        <div className="entry-filter">
          <span>FILTER BY COST TYPE</span>
          <CostTypeLine value={type} onChange={(next) => { setType(next); setOpen(true); }} includeAll label="Filter database search by cost type" />
        </div>
      </div>

      <div className="entry-row">
        <label className="w-no">Item No.<output>{sel?.item_code || '—'}</output></label>
        <label className="w-label">Description<input value={f.label} disabled={!sel} onChange={(e) => setF({ ...f, label: e.target.value })} onKeyDown={onFieldKey} /></label>
        <div className="entry-cost-choice">
          <span>COST TYPE</span>
          <CostTypeLine value={f.cost_type} onChange={(next) => setF({ ...f, cost_type: next })} disabled={!sel} label="Component cost type" />
        </div>
        <label className={`w-parent ${!parent && sel ? 'need' : ''}`}><strong>ASSIGN TO BID ITEM</strong>
          <select value={parent} onChange={(e) => { setParent(e.target.value); setMsg(null); }} aria-required="true">
            <option value="">— Select bid item —</option>
            {groups.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.items.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="w-num">Quantity<input ref={qtyRef} className="num" value={f.qty} disabled={!sel} inputMode="decimal" onChange={(e) => setF({ ...f, qty: e.target.value })} onKeyDown={onFieldKey} /></label>
        <label className="w-unit">Unit<input value={f.unit} disabled={!sel} onChange={(e) => setF({ ...f, unit: e.target.value })} onKeyDown={onFieldKey} /></label>
        <label className="w-num">Unit Cost<input className="num" value={f.unit_cost} disabled={!sel} inputMode="decimal" onChange={(e) => setF({ ...f, unit_cost: e.target.value })} onKeyDown={onFieldKey} /></label>
        <label className="w-num">Extended<output className="num">{ext == null ? '—' : cur(ext)}</output></label>
        <button className="entry-add" onClick={add} disabled={busy}>{busy ? 'Adding…' : '+ ADD TO BID ITEM'}</button>
      </div>
      <div className="entry-cost-key" aria-label="Direct cost classification totals">
        <span className="cost-key-label">DIRECT COSTS</span>
        {TYPES.map((t) => <span className={`cost-key type-${t.toLowerCase()}`} key={t}><b>{t}</b> {TYPE_NAMES[t]} <strong>{cur(est.base?.costs?.[t] || 0)}</strong></span>)}
      </div>
      {msg && <div className={`entry-msg ${msg.kind}`} role={msg.kind === 'error' ? 'alert' : 'status'}>{msg.text}</div>}
      {!parents.length && <div className="entry-msg">No bid items yet. Use <strong>+ Add Section</strong>, then <strong>+ New Bid Item</strong> below.</div>}
    </section>
  );
}
