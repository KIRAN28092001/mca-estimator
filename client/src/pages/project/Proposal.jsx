import { useState } from 'react';
import { api } from '../../api';
import { money } from '../../util';
import { EditCell } from '../../components/ui.jsx';

// Client-facing: selling prices only. No direct costs, markups or internal notes.
const signedMoney = (v) => (v < 0 ? `Deduct (${money(-v)})` : `Add ${money(v)}`);

export default function Proposal({ est, reload, pid }) {
  const [edit, setEdit] = useState(false);
  const [linePrices, setLinePrices] = useState(true);
  const p = est.project;
  const save = (k) => async (v) => { await api.put(`/projects/${pid}`, { [k]: v }); await reload(); };
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const alts = est.alternates.filter((a) => !['rejected', 'excluded'].includes(a.status));
  const accepted = alts.filter((a) => a.included);
  const itemById = new Map(est.items.map((i) => [i.id, i]));
  const text = (k, label) => (
    <section>
      <h3>{label}</h3>
      {edit ? <EditCell multiline value={p[k]} onSave={save(k)} /> : <p className="pre">{p[k] || '—'}</p>}
    </section>
  );

  return (
    <div className="stack">
      <div className="toolbar no-print">
        <label className="check"><input type="checkbox" checked={edit} onChange={(e) => setEdit(e.target.checked)} /> Edit inclusions, exclusions and terms</label>
        <label className="check"><input type="checkbox" checked={linePrices} onChange={(e) => setLinePrices(e.target.checked)} /> Show a price for each bid item</label>
        <span className="spacer" />
        <button className="primary" onClick={() => window.print()}>Print / Save as PDF</button>
      </div>
      <article className="proposal">
        <header>
          <div className="letterhead"><strong>MC Aquatic</strong><span>Commercial Aquatic Construction</span></div>
          <div className="right"><h1>PROPOSAL</h1><div>{today}</div>{p.number && <div>Proposal #{p.number}</div>}</div>
        </header>
        <table className="info">
          <tbody>
            <tr><th>Project</th><td>{p.name}</td><th>Bid date</th><td>{p.bid_date || '—'}</td></tr>
            <tr><th>Location</th><td>{p.location || '—'}</td><th>Estimator</th><td>{p.estimator || '—'}</td></tr>
            <tr><th>Owner</th><td>{p.client || '—'}</td><th>Submitted to</th><td>{p.gc || p.client || '—'}</td></tr>
          </tbody>
        </table>

        {text('inclusions', 'Scope of work')}

        <section>
          <h3>Base bid</h3>
          <table className="price">
            <tbody>
              {est.sections.filter((s) => s.item_ids.length).map((s) => [
                <tr key={`s${s.id}`} className="sec"><td>{s.number}. {s.name}</td><td className="num">{money(s.sell)}</td></tr>,
                ...s.item_ids.map((id) => itemById.get(id)).filter((i) => !i.excluded && i.sell).map((i) => (
                  <tr key={i.id} className="item"><td>{i.number} {i.name}{est.areas.length > 2 ? ` — ${i.area_name}` : ''}</td><td className="num">{linePrices ? money(i.sell) : 'Included'}</td></tr>
                )),
              ])}
              <tr className="grand"><td>Total base bid</td><td className="num">{money(est.totals.base_sell)}</td></tr>
            </tbody>
          </table>
        </section>

        {alts.length > 0 && (
          <section>
            <h3>Value engineering &amp; alternates</h3>
            <table className="price">
              <tbody>
                {alts.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <strong>{a.tag}</strong> — {a.name}{a.included ? ' (accepted)' : ''}
                      {(a.reason || a.description) && <div className="alt-why">{[a.description, a.reason].filter(Boolean).join(' — ')}</div>}
                    </td>
                    <td className="num">{signedMoney(a.net_sell)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {accepted.length > 0 && (
          <section>
            <table className="price">
              <tbody>
                <tr><td>Base bid</td><td className="num">{money(est.totals.base_sell)}</td></tr>
                {accepted.map((a) => <tr key={a.id}><td>{a.tag} — {a.name}</td><td className="num">{signedMoney(a.net_sell)}</td></tr>)}
                <tr className="grand"><td>Adjusted contract amount</td><td className="num">{money(est.totals.grand_sell)}</td></tr>
              </tbody>
            </table>
          </section>
        )}

        {text('exclusions', 'Exclusions')}
        {text('terms', 'Terms & conditions')}

        <section className="sign">
          <div><div className="line" />MC Aquatic — Authorized signature / date</div>
          <div><div className="line" />Accepted by — Signature / date</div>
        </section>
      </article>
    </div>
  );
}
