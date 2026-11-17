import { api } from '../api';
import { useLoad } from '../util';
import { EditCell, ErrorBox, Select } from '../components/ui.jsx';

// Picklist options are edited as "1=White; 2=Quartz"
const optsToText = (o) => (o ? JSON.parse(o).map((x) => `${x.value}=${x.label}`).join('; ') : '');
const textToOpts = (t) => (t || '').split(';').map((s) => s.trim()).filter(Boolean).map((s) => {
  const [v, ...l] = s.split('='); return { value: Number(v), label: (l.join('=') || v).trim() };
});

export default function Variables() {
  const [list, reload, error] = useLoad(() => api.get('/variables'));
  const run = (fn) => async (...a) => { try { await fn(...a); await reload(); } catch (e) { alert(e.message); } };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Takeoff variables</h1>
          <p className="muted">Inputs used by assembly formulas. "Per pool" values are entered for each pool on a project; "Project" values once per job.</p>
        </div>
        <button className="primary" onClick={run(() => api.post('/variables', { name: `MC_NEW_${Date.now() % 10000}`, label: 'New variable', unit: '', default_value: 0 }))}>+ Variable</button>
      </div>
      <ErrorBox error={error} />
      <table className="grid compact">
        <thead><tr><th style={{ width: 60 }}>Order</th><th style={{ width: 330 }}>Name (used in formulas)</th><th>Label</th><th style={{ width: 70 }}>Unit</th><th style={{ width: 120 }}>Input</th><th>Picklist options</th><th style={{ width: 100 }} className="num">Default</th><th style={{ width: 120 }}>Scope</th><th /></tr></thead>
        <tbody>
          {(list || []).map((v) => {
            const put = (k) => run((x) => api.put(`/variables/${v.id}`, { [k]: x }));
            return (
              <tr key={v.id}>
                <td><EditCell type="number" value={v.sort} onSave={(x) => put('sort')(x ?? 0)} /></td>
                <td><EditCell className="mono" value={v.name} onSave={put('name')} title="Renaming does not update existing formulas" /></td>
                <td><EditCell value={v.label} onSave={put('label')} /></td>
                <td><EditCell value={v.unit} onSave={put('unit')} /></td>
                <td><Select value={v.input_type} options={[{ value: 'number', label: 'Number' }, { value: 'picklist', label: 'Picklist' }]} onChange={put('input_type')} /></td>
                <td>{v.input_type === 'picklist' ? <EditCell value={optsToText(v.options)} placeholder="1=White; 2=Quartz" onSave={(t) => put('options')(JSON.stringify(textToOpts(t)))} /> : <span className="muted">—</span>}</td>
                <td><EditCell type="number" value={v.default_value} onSave={(x) => put('default_value')(x ?? 0)} /></td>
                <td><Select value={v.scope} options={[{ value: 'area', label: 'Per pool' }, { value: 'project', label: 'Project' }]} onChange={put('scope')} /></td>
                <td className="actions"><button className="ghost danger" onClick={run(async () => { if (confirm(`Delete ${v.name}? Formulas using it will treat it as 0.`)) await api.del(`/variables/${v.id}`); })}>Delete</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
