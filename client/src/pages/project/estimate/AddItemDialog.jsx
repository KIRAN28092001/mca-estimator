import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../../api';
import { Modal } from '../../../components/ui.jsx';
import { cur, qtyFmt } from './cells.jsx';

/**
 * Search the bid item database (assemblies + items) and add one or many to the worksheet.
 * Keyboard: ↑/↓ move · Enter select · → / ← show / hide components · Ctrl+Enter add selected.
 */
export default function AddItemDialog({ est, pid, init, onClose, saver, onAdded }) {
  const [areaId, setAreaId] = useState(init.area_id || est.areas[0]?.id);
  const [alternateId, setAlternateId] = useState(init.alternate_id ?? '');
  const [sectionId, setSectionId] = useState(String(init.section_id ?? est.sections.at(-1)?.id ?? ''));
  const [catalog, setCatalog] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('all');
  const [hi, setHi] = useState(0);
  const [openKeys, setOpenKeys] = useState(new Set());
  const [sel, setSel] = useState(new Map()); // key → editable row
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const listRef = useRef();

  useEffect(() => {
    let live = true; setCatalog(null); setLoadError(null);
    api.get(`/projects/${pid}/catalog?area_id=${areaId}`).then((r) => live && setCatalog(r.rows)).catch((e) => live && setLoadError(e.message));
    return () => { live = false; };
  }, [pid, areaId]);

  // Already in this pool's estimate → show where
  const inEstimate = useMemo(() => {
    const m = new Map();
    for (const it of est.items) if (it.area_id === Number(areaId) && it.bid_item_no) {
      if (!m.has(it.bid_item_no)) m.set(it.bid_item_no, []); m.get(it.bid_item_no).push(it.number);
    }
    return m;
  }, [est.items, areaId]);

  const rows = useMemo(() => {
    if (!catalog) return [];
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    return catalog.filter((r) => {
      if (kind !== 'all' && r.kind !== kind) return false;
      if (!tokens.length) return true;
      // Cost codes match with or without spaces / dashes ("03 37 13", "033713", "03-37-13")
      const codes = [r.cost_code, ...r.components.map((c) => c.cost_code)].filter(Boolean);
      const hay = [r.bid_item_no, r.name, r.description, r.category, r.unit, ...codes, ...r.components.map((c) => `${c.label} ${c.item_code}`)].join(' ').toLowerCase();
      const compact = hay.replace(/[\s.-]/g, '');
      return tokens.every((t) => hay.includes(t) || compact.includes(t.replace(/[\s.-]/g, '')));
    }).slice(0, 300);
  }, [catalog, q, kind]);
  useEffect(() => { setHi(0); }, [q, kind]);
  useEffect(() => { listRef.current?.querySelector('.is-hi')?.scrollIntoView({ block: 'nearest' }); }, [hi]);

  const toggle = (r) => setSel((m) => {
    const n = new Map(m);
    if (n.has(r.key)) n.delete(r.key);
    else n.set(r.key, { row: r, name: r.name, description: r.description || '', qty: r.default_qty ?? '', unit: r.unit, unit_price: r.default_unit_price, priceTouched: false });
    return n;
  });
  const edit = (key, patch) => setSel((m) => new Map(m).set(key, { ...m.get(key), ...patch }));
  const flip = (key, on) => setOpenKeys((s) => { const n = new Set(s); (on ?? !n.has(key)) ? n.add(key) : n.delete(key); return n; });

  const add = async () => {
    if (!sel.size) return;
    if (!sectionId) { setError('Choose a section (add one first if the estimate has none).'); return; }
    setSaving(true); setError(null);
    const payload = [...sel.values()].map((s) => ({
      [s.row.kind === 'assembly' ? 'assembly_id' : 'item_id']: s.row.id,
      section_id: Number(sectionId),
      area_id: Number(areaId), alternate_id: alternateId ? Number(alternateId) : null,
      name: s.name, description: s.description || null, qty: s.qty === '' ? null : s.qty, unit: s.unit,
      unit_price: s.row.kind === 'item' || s.priceTouched ? s.unit_price : null,
    }));
    let ids = [];
    try {
      await saver.run(`Add ${payload.length} item${payload.length > 1 ? 's' : ''}`, async () => { ids = (await api.post(`/projects/${pid}/estimate-items`, payload)).ids; },
        () => Promise.all(ids.map((i) => api.del(`/estimate-items/${i}`))));
      onAdded(ids); onClose();
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  };

  const onKey = (e) => {
    const r = rows[hi];
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((i) => Math.min(rows.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); add(); }
    else if (e.key === 'Enter' && r) { e.preventDefault(); toggle(r); }
    else if (e.key === 'ArrowRight' && r && e.target.selectionStart === e.target.value.length) { flip(r.key, true); }
    else if (e.key === 'ArrowLeft' && r && openKeys.has(r.key)) { e.preventDefault(); flip(r.key, false); }
  };

  const target = alternateId ? est.alternates.find((a) => a.id === Number(alternateId))?.tag : 'estimate';
  return (
    <Modal title="Add bid items" onClose={onClose} wide>
      <div className="ai-target">
        <label>Section
          <select value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
            {!est.sections.length && <option value="">— add a section first —</option>}
            {est.sections.map((x) => <option key={x.id} value={x.id}>{x.number} – {x.name}</option>)}
          </select>
        </label>
        <label>Pool / area
          <select value={areaId} onChange={(e) => setAreaId(Number(e.target.value))}>
            {est.areas.map((a) => <option key={a.id} value={a.id}>{a.tag} – {a.name}</option>)}
          </select>
        </label>
        <label>Bid group
          <select value={alternateId} onChange={(e) => setAlternateId(e.target.value)}>
            <option value="">Base estimate</option>
            {est.alternates.map((a) => <option key={a.id} value={a.id}>{a.tag} – {a.name}</option>)}
          </select>
        </label>
      </div>

      <div className="ai-search">
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
          placeholder="Search by bid item number, cost code, description, category or keyword…" aria-label="Search bid items" />
        <div className="seg">
          {[['all', 'All'], ['assembly', 'Assemblies'], ['item', 'Items']].map(([k, l]) => <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{l}</button>)}
        </div>
      </div>

      <div className="ai-list" ref={listRef}>
        {loadError && <div className="error">{loadError}</div>}
        {!catalog && !loadError && <div className="muted ai-empty">Loading bid item database…</div>}
        {catalog && !rows.length && <div className="muted ai-empty">No bid items match “{q}”.</div>}
        {catalog && rows.length > 0 && (
          <table className="ai-table">
            <thead><tr><th style={{ width: 28 }} /><th style={{ width: 150 }}>Bid item no.</th><th>Item</th><th style={{ width: 170 }}>Category</th><th style={{ width: 50 }}>Unit</th><th className="num" style={{ width: 70 }}>Def. qty</th><th className="num" style={{ width: 110 }}>Def. unit price</th></tr></thead>
            <tbody>
              {rows.map((r, i) => {
                const on = sel.has(r.key); const open = openKeys.has(r.key); const where = inEstimate.get(r.bid_item_no);
                return [
                  <tr key={r.key} className={`${on ? 'is-sel' : ''} ${i === hi ? 'is-hi' : ''}`} onMouseEnter={() => setHi(i)}>
                    <td><input type="checkbox" checked={on} onChange={() => toggle(r)} aria-label={`Select ${r.bid_item_no}`} /></td>
                    <td className="ai-no">
                      <button className="xp" onClick={() => flip(r.key)} aria-label={open ? 'Hide components' : 'Show components'} title={open ? 'Hide components' : 'Show components'}>{open ? '−' : '+'}</button>
                      <button className="bidno" onClick={() => toggle(r)} title="Select this bid item">{r.bid_item_no}</button>
                    </td>
                    <td onClick={() => toggle(r)} className="click">
                      <div className="strong">{r.name} {r.kind === 'assembly' && <span className="chip">Assembly · {r.components.length}</span>}
                        {where && <span className="chip warn" title="Already in this pool's estimate. You can still add it again.">In estimate {where.join(', ')}</span>}</div>
                      {r.description && <div className="muted small clamp">{r.description}</div>}
                    </td>
                    <td className="small">{r.category}</td>
                    <td>{r.unit}</td>
                    <td className="num">{r.default_qty == null ? '—' : qtyFmt(r.default_qty)}</td>
                    <td className="num">{cur(r.default_unit_price)}</td>
                  </tr>,
                  open && (
                    <tr key={`${r.key}-c`} className="ai-comps"><td /><td colSpan={6}>
                      <table><tbody>
                        {r.components.map((c, k) => (
                          <tr key={k}><td className="mono">{c.item_code}</td><td>{c.label}</td><td className="num">{qtyFmt(c.qty)} {c.unit}</td><td className="num">× {cur(c.unit_cost)}</td><td className="num strong">{cur(c.ext)}</td></tr>
                        ))}
                      </tbody></table>
                      {r.kind === 'assembly' && <div className="muted small">Quantities use the {est.areas.find((a) => a.id === Number(areaId))?.tag} takeoff values.</div>}
                    </td></tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        )}
      </div>

      {sel.size > 0 && (
        <div className="ai-tray">
          <div className="ai-tray-head">{sel.size} selected — edit before adding</div>
          <table>
            <thead><tr><th>Bid item</th><th>Description</th><th className="num">Qty</th><th>Unit</th><th className="num">Unit price</th><th /></tr></thead>
            <tbody>
              {[...sel.entries()].map(([k, s]) => (
                <tr key={k}>
                  <td className="mono">{s.row.bid_item_no}</td>
                  <td><input value={s.name} onChange={(e) => edit(k, { name: e.target.value })} aria-label="Description" /></td>
                  <td><input className="num" value={s.qty} onChange={(e) => edit(k, { qty: e.target.value })} placeholder={s.row.kind === 'assembly' ? '1' : '0'} aria-label="Quantity" /></td>
                  <td><input value={s.unit} onChange={(e) => edit(k, { unit: e.target.value })} style={{ width: 56 }} aria-label="Unit" /></td>
                  <td><input className="num" value={s.unit_price ?? ''} onChange={(e) => edit(k, { unit_price: e.target.value, priceTouched: true })} aria-label="Unit price"
                    title={s.row.kind === 'assembly' ? 'Leave as is to build the price from the components; changing it sets a price override' : 'Copied into this estimate'} /></td>
                  <td><button className="ghost tiny" onClick={() => toggle(s.row)} aria-label="Remove from selection">✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="ai-foot">
        <span className="muted small">↑↓ move · Enter select · → components · Ctrl+Enter add</span>
        {error && <span className="err-inline">{error}</span>}
        <span className="spacer" />
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!sel.size || saving} onClick={add}>{saving ? 'Adding…' : `Add ${sel.size || ''} to ${target}`}</button>
      </div>
    </Modal>
  );
}
