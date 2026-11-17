import { useCallback, useEffect, useState } from 'react';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const num = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

export const money = (v) => (v == null || Math.abs(v) < 0.005 ? '–' : usd.format(v));
export const money0 = (v) => (v == null || Math.abs(v) < 0.5 ? '–' : usd0.format(v));
export const qty = (v) => (v == null ? '' : num.format(v));
export const pct = (v) => `${(v * 100).toFixed(2).replace(/\.?0+$/, '')}%`;

export const TYPES = ['L', 'M', 'E', 'S', 'O'];
export const TYPE_NAMES = { L: 'Labor', M: 'Material', E: 'Equipment', S: 'Subcontract', O: 'Other' };
export const BASIS_NAMES = { M: 'Material cost', L: 'Labor cost', E: 'Equipment cost', S: 'Subcontract cost', O: 'Other cost', direct: 'Total direct cost', running: 'Running total' };

/** Load data from the API with reload(). */
export function useLoad(fn, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const reload = useCallback(async () => {
    try { setData(await fn()); setError(null); } catch (e) { setError(e.message); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { reload(); }, [reload]);
  return [data, reload, error, setData];
}

/** Parse rows pasted from Excel (tab separated) or CSV. First row = headers. */
export function parsePaste(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim());
  if (!lines.length) return [];
  const sep = lines[0].includes('\t') ? '\t' : ',';
  const split = (l) => {
    if (sep === '\t') return l.split('\t');
    const out = []; let cur = ''; let q = false;
    for (const ch of l) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur); return out;
  };
  const heads = split(lines[0]).map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [heads[i], v.trim()])));
}
