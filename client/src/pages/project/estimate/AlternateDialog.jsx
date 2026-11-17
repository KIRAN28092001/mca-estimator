import { useMemo, useState } from 'react';
import { api } from '../../../api';
import { Modal } from '../../../components/ui.jsx';
import { cur, signed, STATUS_LABEL, toCents } from './cells.jsx';

import { TYPE_NAMES as TYPES } from '../../../util';

/** Create or edit a VE deduct / add alternate. */
export default function AlternateDialog({ est, pid, init, onClose, saver }) {
  const existing = init.id ? est.alternates.find((a) => a.id === init.id) : null;
  const [f, setF] = useState(() => existing ? {
    tag: existing.tag, kind: existing.kind, status: existing.status, section_id: existing.section_id ?? '', item_id: existing.item_id ?? '',
    replaces: existing.replaces, bid_item_no: existing.bid_item_no || '', name: existing.name, description: existing.description || '',
    qty: existing.qty ?? '', unit: existing.unit || '', unit_price: existing.unit_price ?? '', cost_type: existing.cost_type || 'S',
    reason: existing.reason || '', notes: existing.notes || '',
  } : {
    tag: '', kind: init.altKind || 'deduct', status: 'proposed', section_id: init.section_id ?? est.sections[0]?.id ?? '', item_id: init.item_id ?? '',
    replaces: !!init.item_id, bid_item_no: '', name: '', description: '', qty: 1, unit: 'LS', unit_price: '', cost_type: 'S', reason: '', notes: '',
  });
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (patch) => setF((x) => ({ ...x, ...patch }));

  const autoTag = useMemo(() => {
    const prefix = f.kind === 'deduct' ? 'VE' : 'ALT';
    const nums = est.alternates.map((a) => new RegExp(`^${prefix}\\s*(\\d+)$`, 'i').exec(a.tag)?.[1]).filter(Boolean).map(Number);
    return `${prefix} ${Math.max(0, ...nums) + 1}`;
  }, [f.kind, est.alternates]);

  // Base bid items of the associated section (all sections when none is chosen)
  const baseItems = est.sections.filter((x) => !f.section_id || x.id === Number(f.section_id)).flatMap((x) => x.item_ids.map((id) => est.items.find((i) => i.id === id)));
  const item = est.items.find((i) => i.id === Number(f.item_id));
  const pickItem = (idv) => {
    const it = est.items.find((i) => i.id === Number(idv));
    set({ item_id: idv, section_id: it?.section_id ?? f.section_id, replaces: !!it && f.replaces, bid_item_no: f.bid_item_no || it?.bid_item_no || '', unit: it && (!f.unit || f.unit === 'LS') ? it.unit : f.unit,
      qty: it && (f.qty === '' || f.qty === 1) ? it.qty : f.qty });
  };

  const qty = f.qty === '' ? 1 : Number(f.qty);
  const price = f.unit_price === '' ? null : Number(f.unit_price);
  const extCents = price == null || !Number.isFinite(qty * price) ? null : Math.round(qty * price * 100);
  // Alternate price = qty × unit price + any detailed items already priced inside it (server totals)
  const savedSimple = existing?.extended != null ? toCents(existing.extended) : 0;
  const detailCents = existing ? toCents(existing.alt_direct) - savedSimple : 0;
  const altCents = (extCents ?? 0) + detailCents;
  const origCents = f.replaces && item ? toCents(item.direct) : 0;
  const netCents = f.replaces && item ? altCents - origCents : f.kind === 'deduct' ? -altCents : altCents;

  const save = async () => {
    setError(null);
    if (!f.name.trim()) { setError('Item name is required'); return; }
    if (f.unit_price !== '' && !(Number(f.unit_price) >= 0)) { setError('Unit price must be a positive number — the type decides add or deduct'); return; }
    if (f.qty !== '' && !Number.isFinite(Number(f.qty))) { setError('Quantity must be a number'); return; }
    const body = {
      ...f, tag: f.tag.trim() || (existing ? existing.tag : undefined), section_id: f.section_id ? Number(f.section_id) : null, item_id: f.item_id ? Number(f.item_id) : null,
      replaces: !!(f.replaces && f.item_id), qty: f.qty === '' ? null : Number(f.qty), unit_price: f.unit_price === '' ? null : Number(f.unit_price),
    };
    setSaving(true);
    try {
      if (existing) {
        const before = Object.fromEntries(Object.keys(body).map((k) => [k, existing[k]]));
        await saver.run(`Edit ${existing.tag}`, () => api.put(`/alternates/${existing.id}`, body), () => api.put(`/alternates/${existing.id}`, before));
      } else {
        let created;
        await saver.run('Add alternate', async () => { created = await api.post(`/projects/${pid}/alternates`, body); }, () => api.del(`/alternates/${created.id}`));
      }
      onClose();
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  };

  return (
    <Modal title={existing ? `Edit ${existing.tag}` : 'Add VE deduct / alternate'} onClose={onClose} wide>
      <div className="alt-form">
        <div className="alt-type" role="radiogroup" aria-label="Alternate type">
          <button role="radio" aria-checked={f.kind === 'deduct'} className={f.kind === 'deduct' ? 'on ded' : ''} onClick={() => set({ kind: 'deduct' })}>
            <strong>VE Deduct</strong><span>Reduces the base estimate when accepted</span>
          </button>
          <button role="radio" aria-checked={f.kind === 'add'} className={f.kind === 'add' ? 'on add' : ''} onClick={() => set({ kind: 'add' })}>
            <strong>Add Alternate</strong><span>Optional upgrade or added scope</span>
          </button>
        </div>

        <div className="fg">
          <label>Alternate no.<input value={f.tag} onChange={(e) => set({ tag: e.target.value })} placeholder={existing ? existing.tag : `${autoTag} (automatic)`} /></label>
          <label>Status
            <select value={f.status} onChange={(e) => set({ status: e.target.value })}>
              {Object.entries(STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <label>Associated section
            <select value={f.section_id} onChange={(e) => set({ section_id: e.target.value, item_id: '', replaces: false })}>
              <option value="">— None —</option>
              {est.sections.map((x) => <option key={x.id} value={x.id}>{x.number} – {x.name}</option>)}
            </select>
          </label>
          <label>Associated bid item
            <select value={f.item_id} onChange={(e) => pickItem(e.target.value)}>
              <option value="">— None —</option>
              {baseItems.map((i) => <option key={i.id} value={i.id}>{i.number} – {i.name.length > 70 ? `${i.name.slice(0, 69)}…` : i.name}{est.areas.length > 1 ? ` [${i.area_tag}]` : ''}</option>)}
            </select>
          </label>
          <label className="span2 check-row">
            <input type="checkbox" checked={!!f.replaces} disabled={!f.item_id} onChange={(e) => set({ replaces: e.target.checked })} />
            <span>Replaces this item — price the alternate as the <strong>net difference</strong> from the original scope{item ? ` (${cur(item.direct)})` : ''}</span>
          </label>
          <label>Bid item no.<input value={f.bid_item_no} onChange={(e) => set({ bid_item_no: e.target.value })} placeholder={item?.bid_item_no || 'e.g. 14.0000.0020'} /></label>
          <label>Item name<input value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Grey broom finish in lieu of salt finish" autoFocus /></label>
          <label className="span2">Description<textarea rows={2} value={f.description} onChange={(e) => set({ description: e.target.value })} /></label>
          <div className="span2 alt-price">
            <label>Quantity<input className="num" value={f.qty} onChange={(e) => set({ qty: e.target.value })} /></label>
            <label>Unit<input value={f.unit} onChange={(e) => set({ unit: e.target.value })} /></label>
            <label>Unit price<input className="num" value={f.unit_price} onChange={(e) => set({ unit_price: e.target.value })} placeholder="0.00" /></label>
            <label>Cost type
              <select value={f.cost_type} onChange={(e) => set({ cost_type: e.target.value })}>{Object.entries(TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            </label>
            <label>Extended amount<output className="num">{extCents == null ? '—' : cur(extCents / 100)}</output></label>
          </div>
          <div className="span2 alt-compare">
            {f.replaces && item ? (
              <>
                <div><span>Original scope</span><strong>{cur(origCents / 100)}</strong><small>{item.number} {item.name}</small></div>
                <div><span>Alternate</span><strong>{cur(altCents / 100)}</strong><small>{existing?.detail_count ? 'incl. detailed items' : 'qty × unit price'}</small></div>
                <div className={netCents < 0 ? 'neg' : 'pos'}><span>Net change (direct cost)</span><strong>{signed(netCents / 100)}</strong><small>markups are added on the worksheet</small></div>
              </>
            ) : (
              <div className={netCents < 0 ? 'neg' : 'pos'}><span>{f.kind === 'deduct' ? 'Deduct from' : 'Add to'} the estimate when accepted (direct cost)</span><strong>{signed(netCents / 100)}</strong>
                <small>Does not change the base estimate. Only “Accepted” alternates count in the adjusted total.</small></div>
            )}
          </div>
          <label className="span2">Reason / scope explanation<textarea rows={2} value={f.reason} onChange={(e) => set({ reason: e.target.value })} placeholder="Shown on the proposal" /></label>
          <label className="span2">Internal notes<textarea rows={2} value={f.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="Not shown to the client" /></label>
        </div>
      </div>
      <div className="ai-foot">
        {existing?.detail_count > 0 && <span className="muted small">Also priced with {existing.detail_count} detailed component line(s) — expand the alternate on the worksheet to edit them.</span>}
        {error && <span className="err-inline">{error}</span>}
        <span className="spacer" />
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save alternate'}</button>
      </div>
    </Modal>
  );
}
