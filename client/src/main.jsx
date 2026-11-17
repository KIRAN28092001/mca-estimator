import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, NavLink, Route, Routes, Navigate } from 'react-router-dom';
import './styles.css';
import Projects from './pages/Projects.jsx';
import Project from './pages/Project.jsx';
import CostCodes from './pages/CostCodes.jsx';
import Items from './pages/Items.jsx';
import Variables from './pages/Variables.jsx';
import Assemblies from './pages/Assemblies.jsx';

function Layout() {
  return (
    <div className="app">
      <aside className="nav">
        <div className="brand">MC Aquatic<small>Estimator</small></div>
        <NavLink to="/projects">Projects</NavLink>
        <div className="nav-group">Database</div>
        <NavLink to="/db/cost-codes">Cost Codes</NavLink>
        <NavLink to="/db/items">Items</NavLink>
        <NavLink to="/db/variables">Variables</NavLink>
        <NavLink to="/db/assemblies">Assemblies</NavLink>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/projects" replace />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/projects/:id/*" element={<Project />} />
          <Route path="/db/cost-codes" element={<CostCodes />} />
          <Route path="/db/items" element={<Items />} />
          <Route path="/db/variables" element={<Variables />} />
          <Route path="/db/assemblies" element={<Assemblies />} />
          <Route path="/db/assemblies/:id" element={<Assemblies />} />
        </Routes>
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter><Layout /></BrowserRouter>
  </React.StrictMode>,
);
