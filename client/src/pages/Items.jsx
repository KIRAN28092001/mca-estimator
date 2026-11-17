import { useState } from 'react';
import { api } from '../api';
import { TYPE_NAMES, useLoad } from '../util';
import { EditCell, ErrorBox, Select } from '../components/ui.jsx';
import { ImportModal } from './CostCodes.jsx';

const TYPES = Object.entries(TYPE_NAMES).map(([value, name]) => ({ value, label: `${value} – ${name}` }));

export default function Items() {
  const [items, reload, error] = useLoad(() => api.get('/items'));
  const [codes] = useLoad(() => api.get('/cost-codes'));
  const [q, setQ] = useState('');
  const [cc, setCc] = useState('');
  const [imp, setImp] = useState(false);
  const run = (fn) => async (...a) => { try { await fn(...a); await reload(); } catch (e) { alert(e.message); } };
  const ccOpts = (codes || []).map((c) => ({ value: c.id, label: `${c.code} – ${c.name}` }));

  const rows = (items || []).filter((i) => (!cc || i.cost_code_id === Number(cc))
    && (!q || `${i.item_code} ${i.description}`.toLowerCase().includes(q.toLowerCase())));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Items</h1>
          <p className="muted">Database items with their cost code, cost type and unit price. Price changes flow into every estimate that uses the item (unless the price was overridden on that estimate).</p>
        </div>
        <button onClick={() => setImp(true)}>Paste from Excel</button>
        <button className="primary" onClick={run(() => api.post('/items', { item_code: '00.0000.0000', description: 'New item', unit: 'EA', cost_type: 'M', unit_cost: 0, cost_code_id: cc ? Number(cc) : null }))}>+ Item</button>
      </div>
      <div className="toolbar">
        <input className="search" placeholder="Search code or description…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select value={cc} onChange={(v) => setCc(v || '')} placeholder="All cost codes" options={ccOpts} />
        <span className="muted">{rows.length} items</span>
      </div>
      <ErrorBox error={error} />
      <table className="grid compact">
        <thead><tr><th style={{ width: 140 }}>Item code</th><th>Description</th><th style={{ width: 240 }}>Cost code</th><th style={{ width: 150 }}>Type</th><th style={{ width: 70 }}>Unit</th><th style={{ width: 120 }} className="num">Unit cost</th><th style={{ width: 60 }}>Active</th><th /></tr></thead>
        <tbody>
          {rows.map((i) => {
            const put = (k) => run((v) => api.put(`/items/${i.id}`, { [k]: v }));
            return (
              <tr key={i.id} className={i.active ? '' : 'excluded'}>
                <td><EditCell className="mono" value={i.item_code} onSave={put('item_code')} /></td>
                <td><EditCell value={i.description} onSave={put('description')} /></td>
                <td><Select value={i.cost_code_id ?? ''} placeholder="— none —" options={ccOpts} onChange={(v) => put('cost_code_id')(v ? Number(v) : null)} /></td>
                <td><Select value={i.cost_type} options={TYPES} onChange={put('cost_type')} /></td>
                <td><EditCell value={i.unit} onSave={put('unit')} /></td>
                <td><EditCell type="number" step="0.01" value={i.unit_cost} onSave={(v) => put('unit_cost')(v ?? 0)} /></td>
                <td className="center"><input type="checkbox" checked={!!i.active} onChange={(e) => put('active')(e.target.checked ? 1 : 0)} /></td>
                <td className="actions"><button className="ghost danger" title={i.usage ? `Used ${i.usage} time(s)` : ''} onClick={run(async () => {
                  if (confirm(`Delete ${i.item_code} ${i.description}?`)) await api.del(`/items/${i.id}`);
                })}>Delete</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {imp && <ImportModal title="Paste items" columns="item_code, description, unit, cost_type (L/M/E/S/O), unit_cost, cost_code" endpoint="/import/items"
        onClose={() => setImp(false)} onDone={reload}
        example={'item_code\tdescription\tunit\tcost_type\tunit_cost\tcost_code\n06.0000.0010\tShotcrete – Material\tCY\tM\t210\t06'} />}
    </div>
  );
}
