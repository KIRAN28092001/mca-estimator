import { NavLink, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { api } from '../api';
import { money, useLoad } from '../util';
import { ErrorBox } from '../components/ui.jsx';
import Setup from './project/Setup.jsx';
import Takeoff from './project/Takeoff.jsx';
import Estimate from './project/Estimate.jsx';
import Summary from './project/Summary.jsx';
import Sov from './project/Sov.jsx';
import Proposal from './project/Proposal.jsx';

const TABS = [
  ['setup', 'Setup'], ['takeoff', 'Takeoff Variables'], ['estimate', 'Estimate'],
  ['summary', 'Summary'], ['sov', 'Schedule of Values'], ['proposal', 'Proposal'],
];

export default function Project() {
  const { id } = useParams();
  const [est, reload, error] = useLoad(() => api.get(`/projects/${id}/estimate`), [id]);
  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!est) return <div className="page muted">Loading…</div>;
  const p = est.project;
  const ctx = { est, reload, pid: Number(id) };

  return (
    <div className="page project">
      <div className="page-head no-print">
        <div>
          <h1>{p.name}</h1>
          <div className="muted">{[p.number && `#${p.number}`, p.client, p.gc, p.location, p.bid_date && `Bid ${p.bid_date}`].filter(Boolean).join(' · ')}</div>
        </div>
        <div className="head-total">
          <small>Base bid</small>
          <strong>{money(est.totals.base_sell)}</strong>
          {est.totals.grand_sell !== est.totals.base_sell && <small>Adjusted total {money(est.totals.grand_sell)}</small>}
          {est.alternates.length > 0 && <small>{est.alternates.length} alternate{est.alternates.length > 1 ? 's' : ''}</small>}
        </div>
      </div>
      <nav className="tabs no-print">
        {TABS.map(([k, label]) => <NavLink key={k} to={k}>{label}</NavLink>)}
      </nav>
      {est.warnings.length > 0 && (
        <details className="warn no-print"><summary>{est.warnings.length} warning{est.warnings.length > 1 ? 's' : ''} in this estimate</summary>
          <ul>{est.warnings.map((w) => <li key={w}>{w}</li>)}</ul></details>
      )}
      <Routes>
        <Route index element={<Navigate to="estimate" replace />} />
        <Route path="setup" element={<Setup {...ctx} />} />
        <Route path="takeoff" element={<Takeoff {...ctx} />} />
        <Route path="estimate" element={<Estimate {...ctx} />} />
        <Route path="summary" element={<Summary {...ctx} />} />
        <Route path="sov" element={<Sov {...ctx} />} />
        <Route path="proposal" element={<Proposal {...ctx} />} />
      </Routes>
    </div>
  );
}
