import { useState } from 'react';
import { api } from '../api';
import { parsePaste, useLoad } from '../util';
import { EditCell, ErrorBox, Modal } from '../components/ui.jsx';

export default function CostCodes() {
  const [list, reload, error] = useLoad(() => api.get('/cost-codes'));
  const [imp, setImp] = useState(false);
  const run = (fn) => async (...a) => { try { await fn(...a); await reload(); } catch (e) { alert(e.message); } };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Cost codes</h1>
          <p className="muted">The master list, numbered by CSI MasterFormat (<code>03 37 13</code> = Division 03 Concrete › Shotcrete). The first two digits set the division used for subtotals. Items point to these codes, so editing a code here updates every item, estimate, summary, SOV and export.</p>
        </div>
        <button onClick={() => setImp(true)}>Paste from Excel</button>
        <button className="primary" onClick={run(() => api.post('/cost-codes', { code: `NEW-${Date.now() % 10000}`, name: 'New cost code' }))}>+ Cost code</button>
      </div>
      <ErrorBox error={error} />
      <table className="grid compact" style={{ maxWidth: 900 }}>
        <thead><tr><th style={{ width: 80 }}>Order</th><th style={{ width: 160 }}>Code</th><th>Description</th><th>Division</th><th className="num">Items</th><th /></tr></thead>
        <tbody>
          {(list || []).map((c) => (
            <tr key={c.id}>
              <td><EditCell type="number" value={c.sort} onSave={run((v) => api.put(`/cost-codes/${c.id}`, { sort: v ?? 0 }))} /></td>
              <td><EditCell className="mono" value={c.code} onSave={run((v) => api.put(`/cost-codes/${c.id}`, { code: v }))} /></td>
              <td><EditCell value={c.name} onSave={run((v) => api.put(`/cost-codes/${c.id}`, { name: v }))} /></td>
              <td className="muted">{c.division} – {c.division_name}</td>
              <td className="num">{c.item_count}</td>
              <td className="actions"><button className="ghost danger" onClick={run(async () => {
                if (confirm(c.item_count ? `${c.item_count} item(s) use ${c.code}. They will become un-coded. Delete anyway?` : `Delete ${c.code}?`)) await api.del(`/cost-codes/${c.id}`);
              })}>Delete</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {imp && <ImportModal title="Paste cost codes" columns="code, name" endpoint="/import/cost-codes" onClose={() => setImp(false)} onDone={reload}
        example={'code\tname\n03 37 13\tShotcrete\n31 23 16\tExcavation'} />}
    </div>
  );
}

export function ImportModal({ title, columns, endpoint, example, onClose, onDone }) {
  const [text, setText] = useState('');
  const [msg, setMsg] = useState(null);
  const rows = parsePaste(text);
  const go = async () => {
    try { const r = await api.post(endpoint, { rows }); setMsg(`Added ${r.added}, updated ${r.updated}${r.skipped ? `, skipped ${r.skipped}` : ''}.`); onDone(); }
    catch (e) { setMsg(e.message); }
  };
  return (
    <Modal title={title} onClose={onClose} wide>
      <p>Copy rows from Excel (including the header row) and paste below. Columns: <code>{columns}</code>. Existing codes are updated, new ones added.</p>
      <textarea className="paste" rows={12} value={text} onChange={(e) => setText(e.target.value)} placeholder={example} />
      <div className="form-actions">
        <span className="muted">{rows.length} row(s) detected{rows[0] ? ` · columns: ${Object.keys(rows[0]).join(', ')}` : ''}</span>
        {msg && <strong>{msg}</strong>}
        <button onClick={onClose}>Close</button>
        <button className="primary" disabled={!rows.length} onClick={go}>Import</button>
      </div>
    </Modal>
  );
}
