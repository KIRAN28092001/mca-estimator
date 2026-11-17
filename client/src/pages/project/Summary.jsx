import { useState } from 'react';
import { money, pct, BASIS_NAMES, TYPES, TYPE_NAMES } from '../../util';

export default function Summary({ est, pid }) {
  const [mode, setMode] = useState('total');
  const val = (c) => (mode === 'total' ? c.total : c.direct);
  const areaTot = (aId) => est.grid.reduce((s, r) => s + val(r.cells[aId]), 0);
  const grand = est.grid.reduce((s, r) => s + val(r), 0);
  const share = (v) => (grand ? pct(v / grand).replace(/(\.\d)\d*%/, '$1%') : '');

  return (
    <div className="stack">
      <section className="card">
        <div className="card-head row">
          <h2>Base bid by CSI division / cost code × pool</h2>
          <div className="chips small">
            <button className={mode === 'total' ? 'on' : ''} onClick={() => setMode('total')}>With markups</button>
            <button className={mode === 'direct' ? 'on' : ''} onClick={() => setMode('direct')}>Direct cost</button>
          </div>
          <span className="spacer" />
          <a className="button" href={`/api/projects/${pid}/export/estimate.xlsx`}>Export estimate to Excel</a>
        </div>
        <div className="scroll-x">
          <table className="grid compact">
            <thead><tr><th>Cost code</th><th>Description</th>{est.areas.map((a) => <th key={a.id} className="num">{a.tag}<div className="sub">{a.name}</div></th>)}<th className="num">Total</th><th className="num">%</th></tr></thead>
            <tbody>
              {est.divisions.map((d) => [
                <tr key={`d${d.division}`} className="group-row">
                  <td className="mono">{d.division}</td><td>{d.name}</td>
                  {est.areas.map((a) => <td key={a.id} className="num">{money(val(d.cells[a.id]))}</td>)}
                  <td className="num strong">{money(val(d))}</td>
                  <td className="num muted">{share(val(d))}</td>
                </tr>,
                ...est.grid.filter((r) => r.division === d.division).map((r) => (
                  <tr key={r.cost_code_id ?? 0}>
                    <td className="mono">{r.code}</td><td>{r.name}</td>
                    {est.areas.map((a) => <td key={a.id} className="num">{money(val(r.cells[a.id]))}</td>)}
                    <td className="num strong">{money(val(r))}</td>
                    <td className="num muted">{share(val(r))}</td>
                  </tr>
                )),
              ])}
            </tbody>
            <tfoot><tr><td /><td>Total</td>{est.areas.map((a) => <td key={a.id} className="num">{money(areaTot(a.id))}</td>)}<td className="num">{money(grand)}</td><td /></tr></tfoot>
          </table>
        </div>
      </section>

      <div className="two-col">
        {est.groups.map((g) => (
          <section className="card" key={g.key}>
            <h2>{g.name}</h2>
            <table className="grid compact totals">
              <tbody>
                {TYPES.map((t) => <tr key={t}><td>{TYPE_NAMES[t]}</td><td className="num">{money(g.costs[t])}</td></tr>)}
                <tr className="sub-total"><td>Direct cost</td><td className="num">{money(g.direct)}</td></tr>
                {g.markups.map((m) => (
                  <tr key={m.id}><td>{m.name} <span className="muted small">{pct(m.percent)} of {BASIS_NAMES[m.basis].toLowerCase()}</span></td><td className="num">{money(m.amount)}</td></tr>
                ))}
                <tr className="grand"><td>{g.alternate ? `Net ${g.total < 0 ? 'deduct' : 'add'} — ${g.alternate.status}${g.alternate.included ? '' : ' (not in total)'}` : 'Base bid total'}</td><td className="num">{money(g.total)}</td></tr>
              </tbody>
            </table>
            {!g.alternate && (
              <>
                <h3>By pool / area</h3>
                <table className="grid compact totals">
                  <tbody>
                    {g.areas.map((a) => <tr key={a.area_id}><td><span className="tag">{a.tag}</span>{a.name}</td><td className="num">{money(a.total)}</td></tr>)}
                  </tbody>
                </table>
              </>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
