import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { money0, useLoad } from '../util';
import { ErrorBox, Field, Modal } from '../components/ui.jsx';

export default function Projects() {
  const [list, reload, error] = useLoad(() => api.get('/projects'));
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const nav = useNavigate();

  const rows = (list || []).filter((p) => !q || `${p.name} ${p.number} ${p.client} ${p.gc} ${p.location}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="page">
      <div className="page-head">
        <h1>Projects</h1>
        <input className="search" placeholder="Search projects…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="primary" onClick={() => setOpen(true)}>+ New project</button>
      </div>
      <ErrorBox error={error} />
      <table className="grid">
        <thead><tr><th>Project</th><th>#</th><th>Client / GC</th><th>Location</th><th>Bid date</th><th>Status</th><th className="num">Pools / areas</th><th className="num">Base bid</th><th /></tr></thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}>
              <td><Link to={`/projects/${p.id}`} className="strong">{p.name}</Link></td>
              <td>{p.number}</td>
              <td>{[p.client, p.gc].filter(Boolean).join(' / ')}</td>
              <td>{p.location}</td>
              <td>{p.bid_date}</td>
              <td><span className="pill">{p.status}</span></td>
              <td className="num">{p.area_count}{p.alternate_count ? ` · ${p.alternate_count} alt` : ''}</td>
              <td className="num strong">{money0(p.base_total)}</td>
              <td className="actions">
                <button className="ghost" onClick={async () => { const c = await api.post(`/projects/${p.id}/duplicate`); nav(`/projects/${c.id}`); }}>Duplicate</button>
                <button className="ghost danger" onClick={async () => { if (confirm(`Delete "${p.name}"? This cannot be undone.`)) { await api.del(`/projects/${p.id}`); reload(); } }}>Delete</button>
              </td>
            </tr>
          ))}
          {list && !rows.length && <tr><td colSpan={9} className="empty">No projects yet.</td></tr>}
        </tbody>
      </table>
      {open && <NewProject onClose={() => setOpen(false)} onCreated={(p) => nav(`/projects/${p.id}`)} />}
    </div>
  );
}

function NewProject({ onClose, onCreated }) {
  const [f, setF] = useState({ name: '', number: '', client: '', gc: '', location: '', bid_date: '', estimator: '', pool_count: 1 });
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    try { onCreated(await api.post('/projects', f)); } catch (x) { setErr(x.message); }
  };
  return (
    <Modal title="New project" onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <Field label="Project name *"><input autoFocus value={f.name} onChange={set('name')} required /></Field>
        <Field label="Project #"><input value={f.number} onChange={set('number')} /></Field>
        <Field label="Client / Owner"><input value={f.client} onChange={set('client')} /></Field>
        <Field label="General contractor"><input value={f.gc} onChange={set('gc')} /></Field>
        <Field label="Location"><input value={f.location} onChange={set('location')} /></Field>
        <Field label="Bid date"><input type="date" value={f.bid_date} onChange={set('bid_date')} /></Field>
        <Field label="Estimator"><input value={f.estimator} onChange={set('estimator')} /></Field>
        <Field label="Number of pools" hint="Creates P1, P2… plus a Site-wide area. You can rename or add more later.">
          <input type="number" min={1} max={20} value={f.pool_count} onChange={set('pool_count')} />
        </Field>
        <ErrorBox error={err} />
        <div className="form-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary">Create project</button></div>
      </form>
    </Modal>
  );
}
