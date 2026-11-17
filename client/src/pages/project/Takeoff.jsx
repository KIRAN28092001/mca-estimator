import { api } from '../../api';
import { useLoad, qty } from '../../util';
import { EditCell } from '../../components/ui.jsx';

export default function Takeoff({ est, reload, pid }) {
  const [vars] = useLoad(() => api.get('/variables'));
  const [vals, reloadVals] = useLoad(() => api.get(`/projects/${pid}/vars`), [pid]);
  if (!vars || !vals) return <div className="muted">Loading…</div>;

  const valueOf = (areaId, vId) => vals.find((x) => x.area_id === areaId && x.variable_id === vId)?.value;
  const save = (areaId, vId) => async (value) => {
    await api.put(`/projects/${pid}/vars`, { area_id: areaId, variable_id: vId, value });
    await Promise.all([reloadVals(), reload()]);
  };
  const projVars = vars.filter((v) => v.scope === 'project');
  const areaVars = vars.filter((v) => v.scope === 'area');

  const input = (v, areaId, fallback) => {
    const val = valueOf(areaId, v.id);
    if (v.input_type === 'picklist') {
      const opts = JSON.parse(v.options || '[]');
      return (
        <select className={`cell ${val == null ? 'inherited' : ''}`} value={val ?? ''} onChange={(e) => save(areaId, v.id)(e.target.value === '' ? null : Number(e.target.value))}>
          <option value="">{`Default (${opts.find((o) => o.value === fallback)?.label ?? fallback})`}</option>
          {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    }
    return <EditCell type="number" value={val} placeholder={qty(fallback)} onSave={save(areaId, v.id)} className={val == null ? 'inherited' : ''} />;
  };

  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <h2>Takeoff variables by pool / area</h2>
          <p className="muted">Enter quantities from the plans for each pool. Assemblies in that pool calculate from these values. Grey = using the default.</p>
        </div>
        <div className="scroll-x">
          <table className="grid compact takeoff">
            <thead>
              <tr><th>Variable</th><th>Unit</th>{est.areas.map((a) => <th key={a.id} className="num">{a.tag}<div className="sub">{a.name}</div></th>)}</tr>
            </thead>
            <tbody>
              {areaVars.map((v) => (
                <tr key={v.id}>
                  <td><div className="strong">{v.label}</div><code className="var">{v.name}</code></td>
                  <td>{v.unit}</td>
                  {est.areas.map((a) => {
                    const pv = valueOf(0, v.id);
                    return <td key={a.id} style={{ minWidth: 120 }}>{input(v, a.id, pv ?? v.default_value)}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {projVars.length > 0 && (
        <section className="card">
          <h2>Project-wide variables</h2>
          <table className="grid compact" style={{ maxWidth: 700 }}>
            <thead><tr><th>Variable</th><th>Unit</th><th className="num">Value</th></tr></thead>
            <tbody>
              {projVars.map((v) => (
                <tr key={v.id}>
                  <td><div className="strong">{v.label}</div><code className="var">{v.name}</code></td>
                  <td>{v.unit}</td>
                  <td style={{ width: 160 }}>{input(v, 0, v.default_value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
