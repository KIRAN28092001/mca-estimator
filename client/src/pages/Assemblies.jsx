import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { money, qty as fq, useLoad } from '../util';
import { EditCell, ErrorBox, TypeBadge } from '../components/ui.jsx';

export default function Assemblies() {
  const { id } = useParams();
  const nav = useNavigate();
  const [list, reloadList, error] = useLoad(() => api.get('/assemblies'));
  useEffect(() => { if (!id && list?.length) nav(`/db/assemblies/${list[0].id}`, { replace: true }); }, [id, list, nav]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Assemblies</h1>
          <p className="muted">Reusable bid items: groups of items whose quantities are calculated by formulas from takeoff variables. When an assembly is added to an estimate its lines and prices are copied, so editing it here never changes an existing estimate (use “Re-sync with database” on the worksheet to pull changes in).</p>
        </div>
        <button className="primary" onClick={async () => { const a = await api.post('/assemblies', { name: 'New assembly' }); await reloadList(); nav(`/db/assemblies/${a.id}`); }}>+ Assembly</button>
      </div>
      <ErrorBox error={error} />
      <div className="split">
        <div className="side-list">
          {(list || []).map((a) => (
            <Link key={a.id} to={`/db/assemblies/${a.id}`} className={String(a.id) === id ? 'on' : ''}>
              <div className="strong">{a.code && <span className="mono muted">{a.code} </span>}{a.name}</div>
              <div className="muted small">{a.item_count} items · used {a.usage}×</div>
            </Link>
          ))}
        </div>
        {id && <Editor key={id} id={id} onChanged={reloadList} onDeleted={async () => { await reloadList(); nav('/db/assemblies'); }} />}
      </div>
    </div>
  );
}

function Editor({ id, onChanged, onDeleted }) {
  const [a, reload, error] = useLoad(() => api.get(`/assemblies/${id}`), [id]);
  const [items] = useLoad(() => api.get('/items'));
  const [vars] = useLoad(() => api.get('/variables'));
  const [testVals, setTestVals] = useState({});
  const [test, setTest] = useState(null);
  const [adding, setAdding] = useState('');
  const run = (fn) => async (...x) => { try { await fn(...x); await reload(); onChanged(); } catch (e) { alert(e.message); } };

  const used = a ? [...new Set(a.items.flatMap((i) => i.variables))] : [];
  useEffect(() => {
    if (!a) return;
    api.post(`/assemblies/${id}/test`, { vars: testVals }).then(setTest).catch(() => setTest(null));
  }, [a, testVals, id]);

  if (error) return <ErrorBox error={error} />;
  if (!a || !items || !vars) return <div className="muted">Loading…</div>;
  const varByName = Object.fromEntries(vars.map((v) => [v.name, v]));

  return (
    <div className="stack grow">
      <section className="card">
        <div className="form-grid cols-4">
          <label className="field"><span>Bid item no.</span><EditCell className="mono" value={a.code} placeholder="e.g. 13 11 23.10" onSave={run((v) => api.put(`/assemblies/${id}`, { code: v }))} /></label>
          <label className="field"><span>Assembly name</span><EditCell value={a.name} onSave={run((v) => api.put(`/assemblies/${id}`, { name: v }))} /></label>
          <label className="field"><span>Category</span><EditCell value={a.category} placeholder="e.g. Pool Structure" onSave={run((v) => api.put(`/assemblies/${id}`, { category: v }))} /></label>
          <label className="field"><span>Unit</span><EditCell value={a.unit} onSave={run((v) => api.put(`/assemblies/${id}`, { unit: v || 'LS' }))} /></label>
          <label className="field" style={{ gridColumn: '1 / -1' }}><span>Description</span><EditCell value={a.description} onSave={run((v) => api.put(`/assemblies/${id}`, { description: v }))} /></label>
        </div>
        <div className="toolbar">
          <span className="spacer" />
          <button className="ghost" onClick={async () => { await api.post(`/assemblies/${id}/duplicate`); onChanged(); }}>Duplicate</button>
          <button className="ghost danger" onClick={async () => { if (confirm(`Delete assembly "${a.name}"? Estimates that already use it keep their copied lines.`)) { await api.del(`/assemblies/${id}`); onDeleted(); } }}>Delete</button>
        </div>
      </section>

      <section className="card">
        <h2>Items &amp; formulas</h2>
        <table className="grid compact">
          <thead><tr><th style={{ width: 56 }}>#</th><th style={{ width: 280 }}>Item</th><th>Line label / quantity formula</th><th style={{ width: 72 }} className="num">Waste %</th><th style={{ width: 100 }} className="num">Test qty</th><th style={{ width: 100 }} className="num">Test total</th><th style={{ width: 36 }} /></tr></thead>
          <tbody>
            {a.items.map((s) => {
              const t = test?.rows.find((r) => r.id === s.id);
              const put = (k) => run((v) => api.put(`/assembly-items/${s.id}`, { [k]: v }));
              return (
                <tr key={s.id} className={s.formula_error || t?.missing?.length ? 'bad' : ''}>
                  <td><EditCell type="number" value={s.sort} onSave={(v) => put('sort')(v ?? 0)} /></td>
                  <td>
                    <select className="cell" value={s.item_id} onChange={(e) => put('item_id')(Number(e.target.value))}>
                      {items.map((i) => <option key={i.id} value={i.id}>{i.item_code} – {i.description}</option>)}
                    </select>
                    <div className="small muted"><TypeBadge t={s.cost_type} /> {s.unit} · {money(s.unit_cost)} · code {s.cost_code}</div>
                  </td>
                  <td>
                    <EditCell value={s.label} placeholder={s.item_description} onSave={put('label')} />
                    <EditCell multiline className="mono formula" value={s.formula} onSave={put('formula')} />
                    {s.formula_error && <div className="err-inline">{s.formula_error}</div>}
                    {t?.missing?.length > 0 && <div className="err-inline">Unknown variable: {t.missing.join(', ')}</div>}
                  </td>
                  <td><EditCell type="number" value={+(s.waste_pct * 100).toFixed(2)} onSave={(v) => put('waste_pct')((v || 0) / 100)} /></td>
                  <td className="num">{t ? `${fq(t.qty)} ${s.unit}` : ''}</td>
                  <td className="num">{t ? money(t.total) : ''}</td>
                  <td className="actions"><button className="ghost danger tiny" onClick={run(() => api.del(`/assembly-items/${s.id}`))}>✕</button></td>
                </tr>
              );
            })}
          </tbody>
          {test && <tfoot><tr><td colSpan={5}>Test total</td><td className="num">{money(test.total)}</td><td /></tr></tfoot>}
        </table>
        <div className="toolbar">
          <select className="cell" style={{ maxWidth: 420 }} value={adding} onChange={(e) => setAdding(e.target.value)}>
            <option value="">Choose an item to add…</option>
            {items.filter((i) => i.active).map((i) => <option key={i.id} value={i.id}>{i.item_code} – {i.description} ({i.unit})</option>)}
          </select>
          <button disabled={!adding} onClick={run(async () => { await api.post(`/assemblies/${id}/items`, { item_id: Number(adding), formula: '0' }); setAdding(''); })}>+ Add item</button>
        </div>
        <p className="muted small">
          Formula help: variables like <code>MC_POOL_WATER_SF</code>; operators <code>+ - * / ^ ( )</code>; comparisons <code>= &lt;&gt; &lt; &lt;= &gt; &gt;=</code>;
          functions <code>IF(cond, a, b)</code> <code>AND(..)</code> <code>OR(..)</code> <code>ROUNDUP(x, 0)</code> <code>ROUND</code> <code>ROUNDDOWN</code> <code>CEILING</code> <code>FLOOR</code> <code>MIN</code> <code>MAX</code> <code>ABS</code>.
          Waste % is added on top of the formula result.
        </p>
      </section>

      <section className="card">
        <h2>Test values</h2>
        <p className="muted small">Try the assembly with sample takeoff numbers. Blank = variable default. (Doesn't change any project.)</p>
        <div className="form-grid cols-4">
          {used.map((n) => {
            const v = varByName[n];
            return (
              <label className="field" key={n}>
                <span>{v ? `${v.label}${v.unit ? ` (${v.unit})` : ''}` : <span className="err-inline">{n} — not defined</span>}</span>
                <input type="number" className="cell num" placeholder={v ? String(v.default_value) : '0'} value={testVals[n] ?? ''}
                  onChange={(e) => setTestVals({ ...testVals, [n]: e.target.value === '' ? undefined : e.target.value })} />
                <small className="mono">{n}</small>
              </label>
            );
          })}
        </div>
      </section>
    </div>
  );
}
