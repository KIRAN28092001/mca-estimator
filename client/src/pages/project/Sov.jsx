import { useState } from 'react';
import { money } from '../../util';

export default function Sov({ est, pid }) {
  const [by, setBy] = useState('area');
  let rows = est.sov;
  if (by === 'code' || by === 'division') {
    const key = (r) => (by === 'code' ? r.cost_code : r.division);
    const m = new Map();
    for (const r of est.sov) {
      if (!m.has(key(r))) {
        m.set(key(r), by === 'code'
          ? { ...r, job_cost_code: r.cost_code, area_tag: '', area_name: '', value: 0 }
          : { ...r, job_cost_code: `Div ${r.division}`, description: r.division_name, area_tag: '', area_name: '', value: 0 });
      }
      m.get(key(r)).value += r.value;
    }
    rows = [...m.values()];
    if (by === 'division') rows.sort((a, b) => a.division.localeCompare(b.division));
  }
  const total = rows.reduce((s, r) => s + r.value, 0);
  let n = 0, last = null;

  return (
    <section className="card">
      <div className="card-head row">
        <h2>Schedule of values — base bid</h2>
        <div className="chips small">
          <button className={by === 'area' ? 'on' : ''} onClick={() => setBy('area')}>By pool + cost code</button>
          <button className={by === 'code' ? 'on' : ''} onClick={() => setBy('code')}>By cost code</button>
          <button className={by === 'division' ? 'on' : ''} onClick={() => setBy('division')}>By CSI division</button>
        </div>
        <span className="spacer" />
        <a className="button primary" href={`/api/projects/${pid}/export/sov.xlsx`}>Export SOV (G703 format)</a>
      </div>
      <p className="muted">Markups are spread across every line in proportion to its cost, so the lines add up exactly to the base bid. The Excel export includes pay application columns with formulas.</p>
      <table className="grid compact" style={{ maxWidth: 900 }}>
        <thead><tr><th style={{ width: 60 }}>Item</th><th style={{ width: 150 }}>Job cost code</th><th>Description of work</th><th className="num">Scheduled value</th><th className="num">%</th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const head = by === 'area' && r.area_id !== last;
            last = r.area_id;
            return [
              head && <tr key={`h${r.area_id}`} className="group-row"><td colSpan={5}><span className="tag">{r.area_tag}</span>{r.area_name}</td></tr>,
              <tr key={`${r.area_id}-${r.job_cost_code}`}>
                <td>{++n}</td><td className="mono">{r.job_cost_code}</td><td>{r.description}</td>
                <td className="num">{money(r.value)}</td><td className="num muted">{total ? ((r.value / total) * 100).toFixed(1) : 0}%</td>
              </tr>,
            ];
          })}
        </tbody>
        <tfoot><tr><td /><td /><td>Total</td><td className="num">{money(total)}</td><td className="num">100%</td></tr></tfoot>
      </table>
    </section>
  );
}
