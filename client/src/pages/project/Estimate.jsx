import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, currentUser, USER_KEY } from '../../api';
import { BASIS_NAMES, TYPES, TYPE_NAMES, useLoad } from '../../util';
import { useSaver } from './estimate/useSaver.js';
import { WsCell, Acct, acct, StatusPill, STATUS_LABEL, signed, cur, qtyFmt, toCents } from './estimate/cells.jsx';
import AddItemDialog from './estimate/AddItemDialog.jsx';
import AlternateDialog from './estimate/AlternateDialog.jsx';
import RevisionsDialog from './estimate/RevisionsDialog.jsx';
import ItemEntryPanel from './estimate/ItemEntryPanel.jsx';
import './estimate/worksheet.css';

const PROJECT_STATUS = ['Estimating', 'Submitted', 'Awarded', 'Lost', 'On Hold'];

// The worksheet is a fixed-layout table with exactly five columns, in this order:
//   + | Bid Item Number | Description | $ VE Deduct / ADD ALT | $ Base Price
// Section headers are separate rows. Column widths never follow the content;
// long text wraps and only the row height grows.
const COLS = 5;
const Cols = () => (
  <colgroup><col className="w-xp" /><col className="w-bid" /><col className="w-desc" /><col className="w-ve" /><col className="w-base" /></colgroup>
);
const sumCents = (list, f) => list.reduce((s, x) => s + toCents(f(x)), 0) / 100;

function useStoredSet(key) {
  const [set, setSet] = useState(() => { try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch { return new Set(); } });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify([...set])); } catch { /* private mode */ } }, [key, set]);
  return [set, setSet];
}

export default function Estimate({ est, reload, pid }) {
  const [revs, reloadRevs] = useLoad(() => api.get(`/projects/${pid}/revisions`), [pid]);
  const reloadAll = useCallback(async () => { await reload(); reloadRevs(); }, [reload, reloadRevs]);
  const saver = useSaver(reloadAll);
  const [dbItems] = useLoad(() => api.get('/items'));
  const [mode, setMode] = useState('cost');
  const [area, setArea] = useState('all');
  const [review, setReview] = useState('all');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useStoredSet(`mca.expanded.${pid}`);
  const [dialog, setDialog] = useState(null);
  const [user, setUser] = useState(currentUser());
  const [focusId, setFocusId] = useState(null); // new empty bid item whose description gets the cursor
  const [focusSectionId, setFocusSectionId] = useState(null); // new section whose name gets the cursor
  const [secPick, setSecPick] = useState(''); // section that + New Bid Item adds to
  const [note, setNote] = useState(null);
  useEffect(() => { // keep the chosen section valid; default to the last section
    if (!est.sections.some((x) => x.id === Number(secPick))) setSecPick(est.sections.at(-1) ? String(est.sections.at(-1).id) : '');
  }, [est.sections, secPick]);
  const editable = mode === 'cost';

  // Ctrl+Z / Cmd+Z undoes the last saved change (outside text fields, where it undoes typing)
  useEffect(() => {
    const k = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) { e.preventDefault(); saver.undo(); }
    };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [saver]);

  const itemById = useMemo(() => new Map(est.items.map((i) => [i.id, i])), [est.items]);
  const toggle = (id) => setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const expandAll = () => setExpanded(new Set([...est.items.map((i) => i.id), ...est.alternates.map((a) => `a${a.id}`)]));
  const normalizedQuery = query.trim().toLowerCase();
  const matchesReview = (it) => review === 'all' || it.components.some((c) => c.cost_type === review);
  const matchesQuery = (it) => !normalizedQuery || [it.number, it.bid_item_no, it.name, it.description,
    ...it.components.flatMap((c) => [c.item_code, c.label, c.unit])]
    .filter(Boolean).join(' ').toLowerCase().includes(normalizedQuery);
  const visible = (it) => (area === 'all' || it.area_id === Number(area)) && matchesReview(it) && matchesQuery(it);

  // ---- Save helpers (each with an undo)
  const editItem = (it, body, label = `Edit ${it.bid_item_no || ''} ${it.name}`) => {
    const prev = {};
    for (const k of Object.keys(body)) {
      if (k === 'unit_price') prev.unit_price = it.unit_price_overridden || it.simple ? it.unit_price : null;
      else if (k === 'total_override') prev.total_override = it.total_overridden ? it.direct : null;
      else prev[k] = it[k];
    }
    if (it.total_overridden && ('qty' in body || 'unit_price' in body)) prev.total_override = it.direct;
    return saver.run(label, () => api.put(`/estimate-items/${it.id}`, body), () => api.put(`/estimate-items/${it.id}`, prev));
  };
  const editComp = (it, c, body) => {
    const prev = {};
    for (const k of Object.keys(body)) prev[k] = k === 'qty' ? (c.qty_overridden ? c.qty : null) : c[k];
    return saver.run(`Edit ${it.name} › ${c.label}`, () => api.put(`/components/${c.id}`, body), () => api.put(`/components/${c.id}`, prev));
  };
  const removeItem = (it) => saver.run(`Delete ${it.bid_item_no || ''} ${it.name}`, () => api.del(`/estimate-items/${it.id}`), () => api.post(`/estimate-items/${it.id}/restore`)).catch(() => {});
  const editAlt = (a, body) => {
    const prev = Object.fromEntries(Object.keys(body).map((k) => [k, a[k]]));
    return saver.run(`Edit ${a.tag}`, () => api.put(`/alternates/${a.id}`, body), () => api.put(`/alternates/${a.id}`, prev));
  };
  const removeAlt = (a) => {
    if (!confirm(`Delete ${a.tag} – ${a.name}${a.detail_count ? ` and its ${a.detail_count} priced line(s)` : ''}?`)) return;
    const body = Object.fromEntries(['tag', 'name', 'kind', 'status', 'section_id', 'item_id', 'replaces', 'bid_item_no', 'description', 'qty', 'unit', 'unit_price', 'cost_type', 'reason', 'notes', 'sort'].map((k) => [k, a[k]]));
    saver.run(`Delete ${a.tag}`, () => api.del(`/alternates/${a.id}`), a.detail_count ? undefined : () => api.post(`/projects/${pid}/alternates`, body)).catch(() => {});
  };
  const quiet = (p) => p?.catch?.(() => {});
  // + New Bid Item: an EMPTY parent at the bottom of the chosen section, numbered by the server
  const newBidItem = (sectionId = Number(secPick)) => {
    if (!sectionId) { setNote('Add a section first (+ Add Section), then create bid items in it.'); return; }
    setNote(null);
    let created;
    quiet(saver.run('New bid item', async () => {
      created = await api.post(`/projects/${pid}/estimate-items/blank`, { section_id: sectionId, area_id: area === 'all' ? undefined : Number(area) });
      setFocusId(created.id);
    }, () => api.del(`/estimate-items/${created.id}`)));
  };
  // + Add Section: next section number from the server; the cursor goes to its name
  const addSection = () => {
    let created;
    setNote(null);
    quiet(saver.run('Add section', async () => {
      created = await api.post(`/projects/${pid}/sections`, { name: 'NEW SECTION' });
      setFocusSectionId(created.id); setSecPick(String(created.id));
    }, () => api.del(`/sections/${created.id}`)));
  };
  const moveSection = (sec, dir) => quiet(saver.run('Move section', () => api.post(`/sections/${sec.id}/move`, { dir }), () => api.post(`/sections/${sec.id}/move`, { dir: -dir })));
  const deleteSection = (sec, count) => {
    if (count) { alert(`${sec.number} – ${sec.name} still has ${count} bid item(s) or alternate(s). Move or delete them first.`); return; }
    if (!confirm(`Delete section ${sec.number} – ${sec.name}?`)) return;
    quiet(saver.run(`Delete section ${sec.name}`, () => api.del(`/sections/${sec.id}`), () => api.post(`/projects/${pid}/sections`, { name: sec.name })));
  };
  const saveUser = (v) => { const n = String(v || '').trim(); try { localStorage.setItem(USER_KEY, n); } catch { /* ignore */ } setUser(n); };

  // ---- Values by mode (Cost = internal direct cost, Sell = with markups)
  const val = (it) => (mode === 'sell' && !it.alternate_id ? it.sell : it.direct);
  const altVal = (a) => (mode === 'sell' ? a.net_sell : a.net_direct);
  const tv = (k) => est.totals[`${k}_${mode === 'sell' ? 'sell' : 'direct'}`];

  // Sections -> bid items. Each alternate sits right after its associated item, else at the end of its section.
  const sectionIds = new Set(est.sections.map((x) => x.id));
  const matchesAltQuery = (a) => !normalizedQuery || [a.tag, a.bid_item_no, a.name, a.description, a.reason].filter(Boolean).join(' ').toLowerCase().includes(normalizedQuery);
  const hasRowFilters = area !== 'all' || review !== 'all' || !!normalizedQuery;
  const rawView = est.sections.map((sec) => {
    const rows = sec.item_ids.map((i) => itemById.get(i)).filter(visible);
    const shown = new Set(rows.map((i) => i.id));
    const allAlts = est.alternates.filter((a) => a.section_id === sec.id);
    const alts = allAlts.filter(matchesAltQuery);
    const after = new Map();
    for (const a of alts) { const k = a.item_id && shown.has(a.item_id) ? a.item_id : 'end'; if (!after.has(k)) after.set(k, []); after.get(k).push(a); }
    // Section subtotal = its parent Base Prices only (never children, never VE)
    const subtotal = hasRowFilters ? sumCents(rows, val) : (mode === 'sell' ? sec.sell : sec.direct);
    return { sec, rows, after, subtotal, count: sec.item_ids.length + allAlts.length };
  });
  const view = hasRowFilters ? rawView.filter(({ rows, after }) => rows.length || after.size) : rawView;
  const orphanAlts = est.alternates.filter((a) => (!a.section_id || !sectionIds.has(a.section_id)) && matchesAltQuery(a));
  // Overall SUBTOTAL = sum of section subtotals (Base Price only; VE deducts / add alternates never added in)
  const subtotal = sumCents(view, (v) => v.subtotal);
  const last = revs?.revisions.at(-1);
  const visibleItems = view.reduce((n, section) => n + section.rows.length, 0);
  const areaItems = est.items.filter((it) => !it.alternate_id && (area === 'all' || it.area_id === Number(area)));
  const hasFilters = area !== 'all' || review !== 'all' || !!normalizedQuery;
  const clearFilters = () => { setArea('all'); setReview('all'); setQuery(''); };
  const ctx = { est, mode, editable, expanded, toggle, focusId, setFocusId, area, review, editItem, editComp, removeItem, editAlt, removeAlt, setDialog, saver, dbItems, val, altVal, pid, quiet };

  return (
    <div className="ws">
      {/* Estimate Center: task-oriented controls inspired by ProEst, expressed in this app's own visual language. */}
      <section className="estimate-center" aria-label="Estimate controls">
        <div className="estimate-titlebar">
          <div className="estimate-title">
            <span className="estimate-eyebrow">ESTIMATE CENTER</span>
            <WsCell value={est.project.estimate_name} className="ws-name" ariaLabel="Estimate name" onSave={(v) => saver.run('Rename estimate', () => api.put(`/projects/${pid}`, { estimate_name: v || 'Base Estimate' }))} />
          </div>
          <button className="revision-btn" onClick={() => setDialog({ kind: 'rev' })} title="Revisions and change history">
            <span>{last ? last.label : 'Draft'}</span>{revs?.working.dirty ? <em>Modified</em> : <em>Revision history</em>}
          </button>
          <label className="status-control"><span>Status</span><select value={est.project.status} aria-label="Estimate status"
            onChange={(e) => quiet(saver.run('Change status', () => api.put(`/projects/${pid}`, { status: e.target.value }), () => api.put(`/projects/${pid}`, { status: est.project.status })))}>
            {PROJECT_STATUS.map((s) => <option key={s}>{s}</option>)}
          </select></label>
          <SaveStatus saver={saver} />
          <span className="spacer" />
          <div className="price-mode" role="group" aria-label="Price display mode">
            <button className={mode === 'cost' ? 'on' : ''} aria-pressed={mode === 'cost'} onClick={() => setMode('cost')}>Cost</button>
            <button className={mode === 'sell' ? 'on' : ''} aria-pressed={mode === 'sell'} onClick={() => setMode('sell')}>Selling price</button>
          </div>
          <input className="bar-user" value={user} onChange={(e) => setUser(e.target.value)} onBlur={(e) => saveUser(e.target.value)} placeholder="Estimator name" aria-label="Your name for the change log" />
        </div>
        <div className="estimate-commandbar">
          <label className="estimate-search"><span className="sr-only">Find in estimate</span><span aria-hidden="true">⌕</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find bid item, description, or database item…" aria-label="Find in estimate" /></label>
          <label className="area-filter"><span>AREA</span><select value={area} onChange={(e) => setArea(e.target.value)} aria-label="Pool filter">
            <option value="all">All pools</option>
            {est.areas.map((a) => <option key={a.id} value={a.id}>{a.tag} – {a.name}</option>)}
          </select></label>
          <div className="review-switch" role="group" aria-label="Review cost type">
            <span>REVIEW</span>
            <button className={review === 'all' ? 'on' : ''} aria-pressed={review === 'all'} onClick={() => setReview('all')}>All</button>
            {TYPES.map((t) => <button key={t} className={`type-${t.toLowerCase()}${review === t ? ' on' : ''}`} aria-pressed={review === t} onClick={() => setReview(t)}><b>{t}</b>{TYPE_NAMES[t]}</button>)}
          </div>
          {hasFilters && <button className="clear-filter" onClick={clearFilters}>Clear filters</button>}
          <span className="match-count">{visibleItems} of {areaItems.length} bid items</span>
          <span className="spacer" />
          <button className="tool-link" onClick={expandAll}>Expand all</button>
          <button className="tool-link" onClick={() => setExpanded(new Set())}>Collapse all</button>
          <button className="tool-link" disabled={!saver.canUndo} onClick={saver.undo} title={saver.canUndo ? `Undo: ${saver.undoLabel} (Ctrl+Z)` : 'Nothing to undo'}>Undo</button>
          <button className="tool-link" onClick={() => setDialog({ kind: 'rev' })}>Revisions</button>
          <a className="tool-link" href={`/api/projects/${pid}/export/estimate.xlsx`}>Export</a>
        </div>
      </section>

      {/* Permanently visible item entry (never hidden behind a button or dialog) */}
      {editable
        ? <ItemEntryPanel est={est} items={dbItems} saver={saver} />
        : <section className="entry"><div className="entry-title">ITEM ENTRY <span>Switch the view to Cost (editable) to add components.</span></div></section>}

      <div className="ws-top">
        <label className="sec-pick">Section
          <select value={secPick} onChange={(e) => setSecPick(e.target.value)} disabled={!est.sections.length} aria-label="Section for the new bid item">
            {!est.sections.length && <option value="">— add a section first —</option>}
            {est.sections.map((x) => <option key={x.id} value={x.id}>{x.number} – {x.name}</option>)}
          </select>
        </label>
        <button className="new-bid" onClick={() => newBidItem()} disabled={!editable}>+ New Bid Item</button>
        <button className="new-alt" onClick={addSection} disabled={!editable}>+ Add Section</button>
        <button className="new-alt" onClick={() => setDialog({ kind: 'add', area_id: area === 'all' ? undefined : Number(area) })} disabled={!editable} title="Create a bid item from a database assembly (components copied in)">+ Bid Item from Assembly</button>
        <button className="new-alt" onClick={() => setDialog({ kind: 'alt' })}>+ VE Deduct / Add Alt</button>
        {mode === 'sell' && <span className="ws-note">Showing selling prices (read-only). Switch to Cost to edit.</span>}
        {note && <span className="ws-note err" role="alert">{note}</span>}
      </div>

      {/* ---------- Worksheet ---------- */}
      <div className="ws-scroll">
        <table className="estimate-table">
          <Cols />
          <thead>
            <tr>
              <th className="c-xp"><span className="sr-only">Expand</span>+</th><th>Bid Item Number</th><th>Description</th>
              <th className="num">$ VE Deduct / ADD ALT</th><th className="num">$ Base Price</th>
            </tr>
          </thead>
          {!est.sections.length && (
            <tbody><tr><td /><td /><td className="empty">No sections yet. Click <strong>+ Add Section</strong> (e.g. POOL, HARDSCAPES), then <strong>+ New Bid Item</strong>.</td><td /><td /></tr></tbody>
          )}
          {view.map(({ sec, rows, after, subtotal: secSub, count }, si) => (
            <tbody key={sec.id} className="sec">
              {/* Section header: an organizational row, not an estimate item; it adds no cost */}
              <tr className="sec-row">
                <td colSpan={3} className="sec-name">
                  <div className="sec-head">
                    <span className="sec-no">{sec.number}</span>
                    <WsCell value={sec.name} disabled={!editable} ariaLabel={`Section ${sec.number} name`} autoFocus={focusSectionId === sec.id}
                      onSave={(v) => saver.run(`Rename section ${sec.number}`, () => api.put(`/sections/${sec.id}`, { name: String(v).toUpperCase() }), () => api.put(`/sections/${sec.id}`, { name: sec.name }))} />
                    {editable && (
                      <span className="sec-tools">
                        <button className="link" onClick={() => newBidItem(sec.id)}>+ Bid Item</button>
                        <button className="link" disabled={si === 0} onClick={() => moveSection(sec, -1)} aria-label="Move section up">↑</button>
                        <button className="link" disabled={si === view.length - 1} onClick={() => moveSection(sec, 1)} aria-label="Move section down">↓</button>
                        <button className="link danger" onClick={() => deleteSection(sec, count)} aria-label="Delete section">Delete</button>
                      </span>
                    )}
                  </div>
                </td>
                <td /><td />
              </tr>
              {!rows.length && !after.size && (
                <tr><td /><td /><td className="empty">No bid items in this section{area !== 'all' ? ' for this pool' : ''}.</td><td /><td /></tr>
              )}
              {rows.map((it) => [
                <ItemRows key={it.id} it={it} ctx={ctx} />,
                ...(after.get(it.id) || []).map((a) => <AltRows key={`a${a.id}`} a={a} ctx={ctx} />),
              ])}
              {(after.get('end') || []).map((a) => <AltRows key={`a${a.id}`} a={a} ctx={ctx} />)}
              <tr className="sec-sub">
                <td colSpan={3} className="sub-label">Subtotal – {sec.name}</td>
                <td className="num" />
                <td className="num" title="Sum of the Base Prices in this section"><Acct value={secSub} /></td>
              </tr>
            </tbody>
          ))}
          {orphanAlts.length > 0 && (
            <tbody className="sec">
              <tr className="sec-row"><td colSpan={3} className="sec-name"><div className="sec-head"><span className="sec-no">—</span>ALTERNATES NOT IN A SECTION</div></td><td /><td /></tr>
              {orphanAlts.map((a) => <AltRows key={`a${a.id}`} a={a} ctx={ctx} />)}
            </tbody>
          )}
          <tfoot>
            <tr className="subtotal">
              <td colSpan={3} className="sub-label">{hasRowFilters ? 'Filtered subtotal' : 'Subtotal'}{area !== 'all' ? ` (${est.areas.find((x) => x.id === Number(area))?.tag} only)` : ''}</td>
              <td className="num" />
              <td className="num" title="Sum of the section subtotals (VE deducts and add alternates are not included)"><Acct value={subtotal} /></td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Other totals: kept separate so they never change the worksheet or its subtotal */}
      <Summary est={est} mode={mode} altVal={altVal} tv={tv} />

      {dialog?.kind === 'add' && <AddItemDialog est={est} pid={pid} init={dialog} saver={saver} onClose={() => setDialog(null)}
        onAdded={(ids) => setExpanded((s) => new Set([...s, ...(ids.length === 1 ? ids : [])]))} />}
      {dialog?.kind === 'alt' && <AlternateDialog est={est} pid={pid} init={dialog} saver={saver} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'rev' && revs && <RevisionsDialog pid={pid} data={revs} reload={reloadRevs} onClose={() => setDialog(null)} />}
    </div>
  );
}

function SaveStatus({ saver }) {
  if (saver.failed.length) {
    return (
      <span className="save is-error" role="alert">
        {saver.failed.length} change{saver.failed.length > 1 ? 's' : ''} not saved
        <button className="link" onClick={saver.retry}>Retry</button>
        <details><summary>Details</summary><ul>{saver.failed.map((f) => <li key={f.id}>{f.label}: {f.error} <button className="link" onClick={() => saver.dismiss(f.id)}>Discard</button></li>)}</ul></details>
      </span>
    );
  }
  if (saver.pending) return <span className="save is-saving">Saving…</span>;
  return <span className="save">{saver.lastSaved ? `Saved ${saver.lastSaved.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'All changes saved'}</span>;
}

/** A parent bid item owns its component build-up. Its Total Cost and Total Estimate are the only values rolled up. */
function ItemRows({ it, ctx, inAlt }) {
  const { editable, expanded, toggle, editItem, quiet, focusId } = ctx;
  const open = expanded.has(it.id);
  const costs = itemCosts(it);
  const totalEstimate = it.sell ?? it.direct;
  const unitEstimate = it.qty ? totalEstimate / it.qty : null;
  const money = (
    <div className="acct">
      <WsCell type="number" value={it.direct} format={acct} disabled={!editable} className={it.total_overridden ? 'ovr' : ''} ariaLabel={inAlt ? 'Alternate total cost' : 'Total cost'}
        title={it.total_overridden ? 'Lump sum entered — clear it in the + rows to go back to qty × unit price' : 'Type an amount to enter a lump-sum price'}
        onSave={(x) => editItem(it, { total_override: x })} />
    </div>
  );
  const flags = [
    ctx.est.areas.length > 1 && it.area_tag, // pool / area (P1, P2, GEN)
    it.assembly_id && it.bid_item_no && `assembly ${it.bid_item_no}`,
    it.excluded && 'Excluded',
    it.total_overridden && 'Lump sum',
    it.unit_price_overridden && 'Unit price override',
    it.price_changes > 0 && `${it.price_changes} database price change${it.price_changes > 1 ? 's' : ''}`,
  ].filter(Boolean);
  return (
    <>
      <tr className={`row-item ${inAlt ? 'in-alt' : ''} ${it.excluded ? 'is-excl' : ''}`}>
        <td className="c-xp">
          <button className="xp" aria-expanded={open} aria-label={open ? 'Collapse bid item' : 'Expand bid item'} onClick={() => toggle(it.id)}>{open ? '−' : '+'}</button>
        </td>
        <td className="c-code" aria-label="Primary database code">{it.cost_code || it.bid_item_no || '—'}</td>
        <td className="c-desc">
          <WsCell wrap value={it.name} disabled={!editable} ariaLabel="Description" placeholder="Enter bid item description"
            autoFocus={focusId === it.id} onSave={(x) => editItem(it, { name: x })} />
          {flags.length > 0 && <div className="flags">{flags.join(' · ')}</div>}
        </td>
        <td className="c-bid" aria-label="Bid item number">{inAlt ? (it.bid_item_no || '—') : it.number}</td>
        <td className="c-alt">{inAlt ? 'Priced alternate' : 'Base estimate'}</td>
        <td className="num"><WsCell type="number" value={it.qty} format={qtyFmt} disabled={!editable} className="grid-input" ariaLabel="Bid item quantity" onSave={(x) => editItem(it, { qty: x ?? 0 })} /></td>
        <td><WsCell value={it.unit} disabled={!editable} className="grid-input grid-unit" ariaLabel="Bid item unit" onSave={(x) => editItem(it, { unit: x })} /></td>
        {COST_TYPES.map((type) => <td key={type} className="num"><Acct value={costs[type] || null} /></td>)}
        <td className="num"><Acct value={unitEstimate} /></td>
        <td className="num total-cost">{money}</td>
        <td className="num"><Acct value={costs.L || null} /></td>
        <td className="num"><Acct value={costs.M || null} /></td>
        <td className="num total-estimate"><Acct value={totalEstimate} /></td>
      </tr>
      {open && <ComponentRows it={it} ctx={ctx} inAlt={inAlt} />}
      {open && <ItemEditRow it={it} ctx={ctx} inAlt={inAlt} />}
      {open && it.total_overridden && editable && (
        <tr className="row-sub"><td /><td /><td colSpan={COLS - 2}><button className="link" onClick={() => quiet(editItem(it, { total_override: null }))}>Clear lump sum (back to quantity × unit price)</button></td></tr>
      )}
    </>
  );
}

/**
 * Child components of a bid item (only shown when the parent is expanded). Each shows its database
 * item number, description, cost type, qty, unit, unit cost and extended cost; all editable,
 * and a component can be moved to another bid item.
 */
function ComponentRows({ it, ctx, inAlt }) {
  const { est, editable, editComp, saver, quiet, review } = ctx;
  const removeComp = (c) => {
    if (!confirm(`Remove "${c.label}" from ${it.bid_item_no || ''} ${it.name}?`)) return;
    let row;
    quiet(saver.run(`Remove ${c.label}`, async () => { row = await api.del(`/components/${c.id}`); },
      () => api.post(`/estimate-items/${it.id}/components`, { item_id: row.item_id, label: row.label, formula: row.formula, waste_pct: row.waste_pct, qty: row.qty, unit: row.unit, unit_cost: row.unit_cost, cost_type: row.cost_type, excluded: row.excluded })));
  };
  const moveComp = (c, to) => {
    const target = est.items.find((x) => x.id === to);
    quiet(saver.run(`Move ${c.label} to ${target?.bid_item_no || ''} ${target?.name || ''}`,
      () => api.put(`/components/${c.id}`, { estimate_item_id: to }), () => api.put(`/components/${c.id}`, { estimate_item_id: it.id })));
  };
  const others = est.items.filter((x) => x.id !== it.id);
  const shownComponents = review === 'all' ? it.components : it.components.filter((c) => c.cost_type === review);
  if (!shownComponents.length) {
    const message = review === 'all'
      ? `No components yet — add them with ITEM ENTRY above (ASSIGN TO BID ITEM: ${it.number} – ${it.name || 'this bid item'}).`
      : `No ${TYPE_NAMES[review].toLowerCase()} components in this bid item.`;
    return <tr className="row-sub"><td /><td /><td colSpan={COLS - 2} className="muted">{message}</td></tr>;
  }
  return shownComponents.map((c) => {
    const fromAssembly = c.assembly_item_id != null; // quantity comes from a takeoff formula
    const extended = componentCost(it, c);
    const componentEstimate = componentShare(it, c, it.sell ?? it.direct);
    const componentQty = (Number(c.qty) || 0) * (Number(it.qty) || 0);
    const unitEstimate = componentQty ? componentEstimate / componentQty : null;
    return (
      <tr key={c.id} className={`row-sub ${c.excluded ? 'is-excl' : ''} ${c.formula_error || c.missing_vars?.length ? 'is-bad' : ''}`}>
        <td className="c-xp" title={TYPE_NAMES[c.cost_type]}><span className={`type-mark type-${c.cost_type.toLowerCase()}`}>{c.cost_type}</span></td>
        <td className="c-code">{c.item_code}</td>
        <td className="c-desc">
          <WsCell wrap value={c.label} disabled={!editable} ariaLabel="Component description" onSave={(x) => editComp(it, c, { label: x })} />
          <details className="component-more">
            <summary>Line options</summary>
            <div className="component-more-panel">
              <div><span className="detail-label">Cost classification</span>
                <div className={`cost-type-line${!editable ? ' is-disabled' : ''}`} role="group" aria-label="Component cost type">
                  {TYPES.map((t) => <button key={t} type="button" disabled={!editable} aria-pressed={c.cost_type === t}
                    className={`cost-type type-${t.toLowerCase()}${c.cost_type === t ? ' is-active' : ''}`}
                    onClick={() => quiet(editComp(it, c, { cost_type: t }))}>
                    <span className="cost-type-code">{t}</span>{TYPE_NAMES[t]}
                  </button>)}
                </div>
              </div>
              {fromAssembly && <label className="formula-field"><span className="detail-label">Quantity formula</span><WsCell value={c.formula} disabled={!editable} className="f-formula" ariaLabel="Quantity formula"
                title={c.formula_error || (c.missing_vars?.length ? `Unknown: ${c.missing_vars.join(', ')}` : c.waste_pct ? `+${(c.waste_pct * 100).toFixed(0)}% waste` : 'Uses this pool’s takeoff values')} onSave={(x) => editComp(it, c, { formula: x })} /></label>}
              {editable && <div className="component-actions">
                {fromAssembly && c.qty_overridden && <button className="link" onClick={() => quiet(editComp(it, c, { qty: null }))}>Use formula quantity</button>}
                <label>Move to <select className="f-move" value="" aria-label="Move component to another bid item" onChange={(e) => e.target.value && moveComp(c, Number(e.target.value))}>
                  <option value="">This bid item</option>
                  {others.map((x) => <option key={x.id} value={x.id}>{x.number} – {x.name.length > 60 ? `${x.name.slice(0, 59).trim()}…` : x.name || '(no description)'}</option>)}
                </select></label>
                <button className="link" onClick={() => quiet(editComp(it, c, { excluded: !c.excluded }))}>{c.excluded ? 'Include' : 'Exclude'}</button>
                <button className="link danger" onClick={() => removeComp(c)}>Remove component</button>
              </div>}
            </div>
          </details>
        </td>
        <td className="c-bid">{it.number}</td>
        <td className="c-alt">{inAlt ? 'Alternate' : 'Base'}</td>
        <td className="num"><WsCell type="number" value={c.qty} format={qtyFmt} disabled={!editable} className={`grid-input ${fromAssembly && c.qty_overridden ? 'ovr' : ''}`} ariaLabel="Component quantity"
          title={fromAssembly ? `Calculated: ${qtyFmt(c.calc_qty)}` : 'Quantity'} onSave={(x) => editComp(it, c, { qty: x })} /></td>
        <td><WsCell value={c.unit} disabled={!editable} className="grid-input grid-unit" ariaLabel="Component unit" onSave={(x) => editComp(it, c, { unit: x })} /></td>
        {COST_TYPES.map((type) => <td key={type} className="num component-cost">{c.cost_type === type
          ? <div className="acct"><WsCell type="number" value={c.unit_cost} format={acct} disabled={!editable} className={c.price_changed ? 'chg' : ''} ariaLabel={`${TYPE_NAMES[type]} unit cost`}
            title={c.price_changed ? `Database price is now ${cur(c.db_unit_cost)}` : `${TYPE_NAMES[type]} unit cost`} onSave={(x) => editComp(it, c, { unit_cost: x })} /></div>
          : ''}</td>)}
        <td className="num"><Acct value={unitEstimate} /></td>
        <td className="num total-cost" title="Extended component cost; included in the parent Total Cost"><Acct value={extended} /></td>
        <td className="num"><Acct value={c.cost_type === 'L' ? extended : null} /></td>
        <td className="num"><Acct value={c.cost_type === 'M' ? extended : null} /></td>
        <td className="num total-estimate" title="Selling-price share of this component"><Acct value={componentEstimate} /></td>
      </tr>
    );
  });
}

/** Quantity, unit, unit price and the other item settings, in one row under the components. */
function ItemEditRow({ it, ctx, inAlt }) {
  const { est, mode, editable, editItem, removeItem, saver, dbItems, quiet } = ctx;
  const [pick, setPick] = useState('');
  const options = useMemo(() => (dbItems || []).filter((i) => i.active).map((i) => ({ i, label: `${i.item_code} — ${i.description}` })), [dbItems]);
  const addComp = () => {
    const o = options.find((x) => x.label === pick); if (!o) return;
    let created;
    quiet(saver.run(`Add component to ${it.name}`, async () => { created = await api.post(`/estimate-items/${it.id}/components`, { item_id: o.i.id }); setPick(''); },
      () => api.del(`/components/${created.id}`)));
  };
  const move = (dir) => quiet(saver.run('Move item', () => api.post(`/estimate-items/${it.id}/move`, { dir }), () => api.post(`/estimate-items/${it.id}/move`, { dir: -dir })));
  return (
    <tr className="row-edit">
      <td /><td />
      <td colSpan={COLS - 2}>
        <div className="item-workbench">
          {editable && (
            <div className="item-add-line">
              <label>Add cost line</label>
              <input list={`dbitems-${it.id}`} value={pick} onChange={(e) => setPick(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addComp()} placeholder="Search the item database to add a component…" aria-label="Add component" />
              <datalist id={`dbitems-${it.id}`}>{options.map((o) => <option key={o.i.id} value={o.label} />)}</datalist>
              <button className="bar-btn" disabled={!options.some((o) => o.label === pick)} onClick={addComp}>Add line</button>
            </div>
          )}
          <div className="item-workbench-foot">
            <span>Built-up unit price <strong>{cur(it.built_unit_price)}</strong>{it.assembly_id ? ` · copied from ${it.assembly_name}` : ''}</span>
            <details className="item-settings">
              <summary>Item settings &amp; actions</summary>
              <div className="edit-grid">
          {!inAlt && (
            <label>Section
              <select value={it.section_id} disabled={!editable} onChange={(e) => {
                const to = est.sections.find((x) => x.id === Number(e.target.value));
                if (confirm(`Move ${it.number} ${it.name || ''} to ${to.number} – ${to.name}? It will get the next number in that section; its components move with it.`)) {
                  quiet(editItem(it, { section_id: to.id }, `Move ${it.number} to ${to.name}`));
                }
              }}>
                {est.sections.map((x) => <option key={x.id} value={x.id}>{x.number} – {x.name}</option>)}
              </select>
            </label>
          )}
          <label>Qty <WsCell type="number" value={it.qty} format={qtyFmt} disabled={!editable} className="f-qty" ariaLabel="Quantity" onSave={(x) => editItem(it, { qty: x ?? 0 })} /></label>
          <label>Unit <WsCell value={it.unit} disabled={!editable} className="f-unit" ariaLabel="Unit" onSave={(x) => editItem(it, { unit: x })} /></label>
          <label>Unit price <WsCell type="number" value={mode === 'sell' && !inAlt ? (it.qty ? it.sell / it.qty : null) : it.unit_price} format={cur} disabled={!editable}
            className={`f-money ${it.unit_price_overridden ? 'ovr' : ''}`} ariaLabel="Unit price" onSave={(x) => editItem(it, { unit_price: x })} />
            {it.unit_price_overridden && editable && <button className="link" title={`Built-up price ${cur(it.built_unit_price)}`} onClick={() => quiet(editItem(it, { unit_price: null }))}>use built-up {cur(it.built_unit_price)}</button>}
          </label>
          <label>Pool
            <select value={it.area_id} disabled={!editable} onChange={(e) => quiet(editItem(it, { area_id: Number(e.target.value) }))}>
              {est.areas.map((a) => <option key={a.id} value={a.id}>{a.tag} – {a.name}</option>)}
            </select>
          </label>
          <label>Bid group
            <select value={it.alternate_id ?? ''} disabled={!editable} onChange={(e) => quiet(editItem(it, { alternate_id: e.target.value ? Number(e.target.value) : null }))}>
              <option value="">Base estimate</option>
              {est.alternates.map((a) => <option key={a.id} value={a.id}>{a.tag} – {a.name}</option>)}
            </select>
          </label>
          <label className="wide">Notes <WsCell wrap value={it.notes || ''} disabled={!editable} className="f-notes" ariaLabel="Internal notes" placeholder="Internal notes" onSave={(x) => editItem(it, { notes: x })} /></label>
          <span className="wide actions">
            {editable && !inAlt && <><button className="link" onClick={() => move(-1)}>Move up</button><button className="link" onClick={() => move(1)}>Move down</button></>}
            {editable && <button className="link" onClick={() => quiet(editItem(it, { excluded: !it.excluded }))}>{it.excluded ? 'Include' : 'Exclude'}</button>}
            {editable && <button className="link" onClick={() => quiet(saver.run(`Update ${it.name} from database`, () => api.post(`/estimate-items/${it.id}/refresh`)))}>
              {it.price_changes ? `Update ${it.price_changes} changed price${it.price_changes > 1 ? 's' : ''} from database` : 'Re-sync with database'}</button>}
            {editable && <button className="link danger" title="Ctrl+Z to undo" onClick={() => removeItem(it)}>Delete bid item</button>}
          </span>
              </div>
            </details>
          </div>
        </div>
      </td>
    </tr>
  );
}

function AltRows({ a, ctx }) {
  const { est, mode, editable, expanded, toggle, editAlt, removeAlt, setDialog, altVal, quiet } = ctx;
  const key = `a${a.id}`;
  const open = expanded.has(key);
  const detail = est.items.filter((i) => i.alternate_id === a.id);
  const simple = !a.replaces && !detail.length && (a.qty == null || a.qty === 1);
  const replaced = a.item_id ? est.items.find((i) => i.id === a.item_id) : null;
  return (
    <>
      <tr className={`row-alt st-row-${a.status}`}>
        <td className="c-xp">
          <button className="xp" aria-expanded={open} aria-label={open ? 'Collapse alternate' : 'Expand alternate'} onClick={() => toggle(key)}>{open ? '−' : '+'}</button>
        </td>
        <td className="c-code">{a.bid_item_no || '—'}</td>
        <td className="c-desc">
          <WsCell wrap value={a.name} disabled={!editable} ariaLabel="Alternate name" onSave={(x) => editAlt(a, { name: x })} />
          <div className="flags">
            {a.kind === 'deduct' ? 'VE deduct' : 'Add alternate'}
            {' · '}
            <select className={`st-select st-${a.status}`} value={a.status} aria-label="Alternate status" onChange={(e) => quiet(editAlt(a, { status: e.target.value }))}>
              {Object.entries(STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            {a.replaces && replaced && <> · replaces {replaced.number} {replaced.name}</>}
            {!a.included && ' · not in totals until accepted'}
          </div>
        </td>
        <td className="c-bid">{a.item_number || a.tag}</td>
        <td className="c-alt"><StatusPill status={a.status} /><span className={`alt-kind ${a.kind}`}>{a.kind === 'deduct' ? 'VE deduct' : 'Add alternate'}</span></td>
        <td className="num">{a.qty != null ? qtyFmt(a.qty) : ''}</td>
        <td>{a.unit || ''}</td>
        {COST_TYPES.map((type) => <td key={type} className="num">{a.cost_type === type ? <Acct value={a.unit_price} /> : ''}</td>)}
        <td className="num"><Acct value={a.qty ? (a.net_sell / a.qty) : null} /></td>
        <td className="num total-cost">
          {simple && editable
            ? <div className="acct"><WsCell type="number" value={a.net_direct} format={acct} ariaLabel="VE / alternate amount" title="Negative = deduct, positive = add"
              onSave={(x) => editAlt(a, { unit_price: Math.abs(x ?? 0), qty: 1, kind: (x ?? 0) < 0 ? 'deduct' : 'add' })} /></div>
            : <Acct value={a.net_direct} title={a.replaces ? `Alternate ${cur(a.alt_direct)} − original ${cur(a.original_direct)}` : undefined} />}
        </td>
        <td className="num"><Acct value={a.cost_type === 'L' ? a.net_direct : null} /></td>
        <td className="num"><Acct value={a.cost_type === 'M' ? a.net_direct : null} /></td>
        <td className="num total-estimate"><Acct value={a.net_sell} title={`Net adjustment ${signed(altVal(a))}`} /></td>
      </tr>
      {open && (
        <tr className="row-edit">
          <td /><td />
          <td colSpan={COLS - 2}>
            <div className="edit-grid">
              <label>Qty <WsCell type="number" value={a.qty} format={qtyFmt} disabled={!editable || a.unit_price == null} className="f-qty" ariaLabel="Alternate quantity" onSave={(x) => editAlt(a, { qty: x })} /></label>
              <label>Unit <WsCell value={a.unit} disabled={!editable} className="f-unit" ariaLabel="Alternate unit" onSave={(x) => editAlt(a, { unit: x })} /></label>
              <label>Unit price <WsCell type="number" value={a.unit_price} format={cur} disabled={!editable} className="f-money" ariaLabel="Alternate unit price" onSave={(x) => editAlt(a, { unit_price: x == null ? null : Math.abs(x) })} /></label>
              <span className="wide cmp-line">
                Original {a.replaces ? cur(mode === 'sell' ? a.original_sell : a.original_direct) : '—'}
                {' → '}Alternate {cur(mode === 'sell' ? a.alt_sell : a.alt_direct)}
                {' = '}<strong>Net {signed(altVal(a))}</strong>
              </span>
              {(a.reason || a.notes) && <span className="wide muted">{[a.reason && `Reason: ${a.reason}`, a.notes && `Notes: ${a.notes}`].filter(Boolean).join(' · ')}</span>}
              <span className="wide actions">
                {editable && <button className="link" onClick={() => setDialog({ kind: 'add', alternate_id: a.id })}>+ Price with bid items</button>}
                <button className="link" onClick={() => setDialog({ kind: 'alt', id: a.id })}>Edit all fields</button>
                {editable && <button className="link danger" onClick={() => removeAlt(a)}>Delete alternate</button>}
              </span>
            </div>
          </td>
        </tr>
      )}
      {open && detail.map((it) => <ItemRows key={it.id} it={it} ctx={ctx} inAlt />)}
    </>
  );
}

/** Totals outside the worksheet: VE / alternates, grand total and cost build-up. */
function Summary({ est, mode, altVal, tv }) {
  const T = est.totals;
  const sell = mode === 'sell';
  const by = (st) => est.alternates.filter((a) => a.status === st);
  return (
    <div className="ws-summary">
      <table className="estimate-table summary-table">
        <tbody>
          <tr><th colSpan={3}>Section subtotals ({sell ? 'selling price' : 'direct cost'})</th></tr>
          {est.sections.map((x) => <tr key={x.id}><td className="num">{x.number}</td><td>{x.name}</td><td className="num">{cur(sell ? x.sell : x.direct)}</td></tr>)}
          <tr className="strong"><td /><td>Base estimate subtotal</td><td className="num">{cur(tv('base'))}</td></tr>
        </tbody>
      </table>
      <table className="estimate-table summary-table">
        <tbody>
          <tr><th colSpan={2}>Estimate totals ({sell ? 'selling price' : 'direct cost'})</th></tr>
          <tr><td>Base estimate subtotal</td><td className="num">{cur(tv('base'))}</td></tr>
          <tr><td>VE deduct total (accepted)</td><td className="num">{signed(tv('ve'))}</td></tr>
          <tr><td>Add alternate total (accepted)</td><td className="num">{signed(tv('add'))}</td></tr>
          <tr><td>Optional items (proposed / pending — not included)</td><td className="num">{signed(tv('optional'))}</td></tr>
          <tr className="strong"><td>Grand total</td><td className="num">{cur(tv('grand'))}</td></tr>
          {Object.keys(STATUS_LABEL).map((st) => by(st).length > 0 && (
            <tr key={st}><td colSpan={2} className="small"><StatusPill status={st} /> {by(st).map((a) => `${a.tag} ${signed(altVal(a))}`).join(' · ')}</td></tr>
          ))}
        </tbody>
      </table>
      <table className="estimate-table summary-table">
        <tbody>
          <tr><th colSpan={2}>Cost to selling price (base estimate)</th></tr>
          {TYPES.map((t) => <tr key={t}><td>{est.type_names[t]}</td><td className="num">{cur(est.base.costs[t])}</td></tr>)}
          <tr className="strong"><td>Direct cost</td><td className="num">{cur(T.base_direct)}</td></tr>
          {est.base.markups.map((m) => <tr key={m.id}><td>{m.name} ({+(m.percent * 100).toFixed(3)}% of {BASIS_NAMES[m.basis].toLowerCase()})</td><td className="num">{cur(m.amount)}</td></tr>)}
          <tr className="strong"><td>Base estimate — selling price</td><td className="num">{cur(T.base_sell)}</td></tr>
        </tbody>
      </table>
    </div>
  );
}
