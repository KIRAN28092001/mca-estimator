import { Link } from 'react-router-dom';
import { api } from '../../api';
import { BASIS_NAMES, money } from '../../util';
import { EditCell, Field, Select } from '../../components/ui.jsx';

const run = (fn, reload) => async (...a) => { try { await fn(...a); await reload(); } catch (e) { alert(e.message); } };

export default function Setup({ est, reload, pid }) {
  const p = est.project;
  const save = (k) => run((v) => api.put(`/projects/${pid}`, { [k]: v }), reload);
  const STATUS = ['Estimating', 'Submitted', 'Awarded', 'Lost', 'On Hold'].map((s) => ({ value: s, label: s }));

  return (
    <div className="stack">
      <section className="card">
        <h2>Project information</h2>
        <div className="form-grid cols-4">
          {[['name', 'Project name'], ['number', 'Project #'], ['client', 'Client / Owner'], ['gc', 'General contractor'],
            ['location', 'Location'], ['estimator', 'Estimator']].map(([k, l]) => (
            <Field key={k} label={l}><EditCell value={p[k]} onSave={save(k)} /></Field>
          ))}
          <Field label="Bid date"><input type="date" className="cell" value={p.bid_date || ''} onChange={(e) => save('bid_date')(e.target.value)} /></Field>
          <Field label="Status"><Select value={p.status} options={STATUS} onChange={save('status')} /></Field>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Pools / areas</h2>
          <p className="muted">Each pool is priced separately using the same cost codes. The tag is added to the cost code for job costing (e.g. 03 37 13-P1).</p>
        </div>
        <table className="grid compact">
          <thead><tr><th style={{ width: 90 }}>Tag</th><th>Name</th><th className="num">Base bid</th><th /></tr></thead>
          <tbody>
            {est.areas.map((a) => (
              <tr key={a.id}>
                <td><EditCell value={a.tag} onSave={run((v) => api.put(`/areas/${a.id}`, { tag: v }), reload)} /></td>
                <td><EditCell value={a.name} onSave={run((v) => api.put(`/areas/${a.id}`, { name: v }), reload)} /></td>
                <td className="num">{money(est.base.areas.find((x) => x.area_id === a.id)?.total)}</td>
                <td className="actions"><button className="ghost danger" onClick={run(async () => {
                  if (confirm(`Delete ${a.tag} – ${a.name} and everything priced in it?`)) await api.del(`/areas/${a.id}`);
                }, reload)}>Delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="add" onClick={run(() => {
          const n = est.areas.filter((a) => /^P\d+$/.test(a.tag)).length + 1;
          return api.post(`/projects/${pid}/areas`, { tag: `P${n}`, name: `Pool ${n}`, sort: n });
        }, reload)}>+ Add pool / area</button>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Alternates</h2>
          <p className="muted">VE deducts and add alternates are priced separately from the base bid and only change the total once accepted.</p>
        </div>
        <table className="grid compact">
          <thead><tr><th style={{ width: 90 }}>No.</th><th>Description</th><th style={{ width: 110 }}>Type</th><th style={{ width: 110 }}>Status</th><th className="num">Net change (sell)</th></tr></thead>
          <tbody>
            {est.alternates.map((a) => (
              <tr key={a.id}>
                <td className="mono">{a.tag}</td><td>{a.name}</td>
                <td>{a.kind === 'deduct' ? 'VE deduct' : 'Add alternate'}</td>
                <td style={{ textTransform: 'capitalize' }}>{a.status}</td>
                <td className="num">{money(a.net_sell)}</td>
              </tr>
            ))}
            {!est.alternates.length && <tr><td colSpan={5} className="empty">No alternates.</td></tr>}
          </tbody>
        </table>
        <p className="muted small">Create, price and accept alternates on the <Link to="../estimate">Estimate</Link> tab.</p>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Markups</h2>
          <p className="muted">Applied top to bottom to the base bid and each alternate. "Running total" compounds on everything above it.</p>
        </div>
        <table className="grid compact">
          <thead><tr><th style={{ width: 60 }}>Order</th><th>Markup</th><th style={{ width: 110 }} className="num">Percent</th><th style={{ width: 200 }}>Applied to</th><th className="num">Base bid amount</th><th /></tr></thead>
          <tbody>
            {est.markups.map((m, i) => (
              <tr key={m.id}>
                <td><EditCell type="number" value={m.sort} onSave={run((v) => api.put(`/markups/${m.id}`, { sort: v ?? 0 }), reload)} /></td>
                <td><EditCell value={m.name} onSave={run((v) => api.put(`/markups/${m.id}`, { name: v }), reload)} /></td>
                <td><EditCell type="number" step="0.01" value={+(m.percent * 100).toFixed(4)} onSave={run((v) => api.put(`/markups/${m.id}`, { percent: (v || 0) / 100 }), reload)} /></td>
                <td><Select value={m.basis} options={Object.entries(BASIS_NAMES).map(([value, label]) => ({ value, label }))} onChange={run((v) => api.put(`/markups/${m.id}`, { basis: v }), reload)} /></td>
                <td className="num">{money(est.base.markups[i]?.amount)}</td>
                <td className="actions"><button className="ghost danger" onClick={run(() => api.del(`/markups/${m.id}`), reload)}>Delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="add" onClick={run(() => api.post(`/projects/${pid}/markups`, { name: 'New markup', percent: 0, basis: 'running' }), reload)}>+ Add markup</button>
      </section>
    </div>
  );
}
