import { useState } from 'react';
import { api } from '../../../api';
import { Modal } from '../../../components/ui.jsx';
import { cur, signed, qtyFmt } from './cells.jsx';

const when = (s) => new Date(`${s.replace(' ', 'T')}Z`).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const FIELD = { name: 'Description', qty: 'Qty', unit: 'Unit', unit_price: 'Unit price', direct: 'Base cost', excluded: 'Excluded', area_tag: 'Pool' };
const show = (f, v) => (['unit_price', 'direct'].includes(f) ? cur(v) : f === 'qty' ? qtyFmt(v) : String(v));

function Changes({ c }) {
  if (!c) return <p className="muted small">First issued revision.</p>;
  if (!c.items.length && !c.alternates.length) return <p className="muted small">No changes to items or alternates.</p>;
  return (
    <table className="rv-table">
      <tbody>
        {c.items.map((i) => (
          <tr key={`i${i.id}`}>
            <td><span className={`chg chg-${i.change}`}>{i.change}</span></td>
            <td className="mono">{i.number || ''}</td>
            <td>{i.bid_item_no} {i.name} {i.area_tag && <span className="chip">{i.area_tag}</span>}</td>
            <td className="small">{i.change === 'changed' ? i.fields.map((f) => <div key={f}>{FIELD[f] || f}: {show(f, i.before[f])} → <strong>{show(f, i[f])}</strong></div>) : cur(i.direct)}</td>
          </tr>
        ))}
        {c.alternates.map((a) => (
          <tr key={`a${a.id}`}>
            <td><span className={`chg chg-${a.change}`}>{a.change}</span></td>
            <td className="mono">{a.tag}</td><td>{a.name}</td>
            <td className="small">{a.change === 'changed' ? <>{a.before.status !== a.status && <div>Status: {a.before.status} → <strong>{a.status}</strong></div>}
              {a.before.net_direct !== a.net_direct && <div>Net: {signed(a.before.net_direct)} → <strong>{signed(a.net_direct)}</strong></div>}</> : signed(a.net_direct)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function RevisionsDialog({ pid, data, onClose, reload }) {
  const next = data.revisions.length ? data.revisions.at(-1).rev + 1 : 0;
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);
  const issue = async () => {
    setBusy(true); setError(null);
    try { await api.post(`/projects/${pid}/revisions`, { label, note }); setLabel(''); setNote(''); await reload(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const w = data.working;

  return (
    <Modal title="Estimate revisions" onClose={onClose} wide>
      <section className="rv-issue">
        <div>
          <h4>Issue Rev {next}</h4>
          <p className="muted small">Freezes a copy of the worksheet and totals. Later edits never change an issued revision.</p>
        </div>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={`Rev ${next}`} aria-label="Revision label" />
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note, e.g. Bid day pricing / Addendum 2" aria-label="Revision note" style={{ flex: 2 }} />
        <button className="primary" onClick={issue} disabled={busy}>{busy ? 'Issuing…' : `Issue Rev ${next}`}</button>
      </section>
      {error && <div className="error">{error}</div>}

      <h4 className="rv-h">Working copy {data.revisions.length ? `— changes since ${data.revisions.at(-1).label}` : ''}</h4>
      <div className="rv-totals">
        <span>Base estimate <strong>{cur(w.totals.base_sell)}</strong></span>
        <span>Adjusted total <strong>{cur(w.totals.grand_sell)}</strong></span>
        {w.changes && <span>Δ vs last rev <strong className={w.changes.totals.grand_sell.delta < 0 ? 'neg' : ''}>{signed(w.changes.totals.grand_sell.delta)}</strong></span>}
      </div>
      {w.changes && <Changes c={w.changes} />}
      {w.log.length > 0 && (
        <details className="rv-log" open={!data.revisions.length}>
          <summary>{w.log.length} logged change{w.log.length > 1 ? 's' : ''} — who and when</summary>
          <table className="rv-table">
            <tbody>{w.log.map((l) => (
              <tr key={l.id}><td className="small nowrap">{when(l.at)}</td><td className="small strong nowrap">{l.user}</td><td className="small mono">{l.action}</td><td className="small">{l.detail}</td></tr>
            ))}</tbody>
          </table>
        </details>
      )}

      <h4 className="rv-h">Issued revisions</h4>
      {!data.revisions.length && <p className="muted">No revisions issued yet. Issue Rev 0 when the estimate goes out.</p>}
      {[...data.revisions].reverse().map((r) => (
        <div key={r.id} className="rv-row">
          <button className="rv-head" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
            <span className="rv-badge">{r.label}</span>
            <span className="muted small">{when(r.created_at)} · {r.created_by}</span>
            {r.note && <span className="small">{r.note}</span>}
            <span className="spacer" />
            <span className="small">Base {cur(r.totals.base_sell)}</span>
            <strong>{cur(r.totals.grand_sell)}</strong>
          </button>
          {open === r.id && <div className="rv-body"><Changes c={r.changes} /></div>}
        </div>
      ))}
    </Modal>
  );
}
