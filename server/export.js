// Excel exports (ExcelJS). Each export returns a Workbook built from a computed estimate.
const ExcelJS = require('exceljs');

const MONEY = '$#,##0.00;($#,##0.00);"-"';
const QTY = '#,##0.00';
const FONT = { name: 'Arial', size: 10 };
const HEAD = { font: { ...FONT, bold: true, color: { argb: 'FFFFFFFF' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } } };
const TYPES = ['L', 'M', 'E', 'S', 'O'];
const TYPE_NAMES = { L: 'Labor', M: 'Material', E: 'Equipment', S: 'Subcontractor', O: 'Other' };

function sheet(wb, name, widths) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 0 }] });
  ws.columns = widths.map((w) => ({ width: w, style: { font: FONT } }));
  return ws;
}
function title(ws, e, text) {
  ws.addRow([text]).font = { ...FONT, bold: true, size: 14 };
  ws.addRow([`${e.project.name}${e.project.number ? `  ·  #${e.project.number}` : ''}`]).font = { ...FONT, bold: true };
  ws.addRow([[e.project.client, e.project.location, e.project.bid_date && `Bid date ${e.project.bid_date}`].filter(Boolean).join('  ·  ')]);
  ws.addRow([]);
}
function header(ws, cols) {
  const r = ws.addRow(cols);
  r.eachCell((c) => { c.font = HEAD.font; c.fill = HEAD.fill; c.alignment = { vertical: 'middle', wrapText: true }; });
  return r;
}
const bold = (row) => row.eachCell((c) => { c.font = { ...FONT, bold: true }; });

function estimate(e) {
  const wb = new ExcelJS.Workbook(); wb.creator = 'MC Aquatic Estimator';

  // --- Worksheet (same structure as the Estimate screen; direct cost)
  // Same structure as the screen: section header, its bid items (1.1, 1.2 …) with alternates, section subtotal
  const w = sheet(wb, 'Worksheet', [9, 54, 10, 7, 14, 18, 18]);
  title(w, e, `${(e.project.estimate_name || 'ESTIMATE').toUpperCase()} — WORKSHEET (direct cost)`);
  header(w, ['Bid Item No.', 'Description', 'Qty', 'Unit', 'Unit Price', '$ VE Deduct / ADD ALT', '$ Base Price']).height = 30;
  const altRow = (a) => {
    const r = w.addRow([a.tag, `${a.name} — ${a.status.toUpperCase()}${a.included ? '' : ' (not in total)'}`, a.qty, a.unit, a.unit_price, a.net_direct, null]);
    r.getCell(3).numFmt = QTY; r.getCell(5).numFmt = MONEY; r.getCell(6).numFmt = MONEY;
    r.getCell(2).font = { ...FONT, italic: true }; r.getCell(2).alignment = { wrapText: true, vertical: 'top' };
  };
  const subRows = [];
  for (const s of e.sections) {
    const hr = w.addRow([String(s.number), s.name]); bold(hr);
    hr.eachCell((c) => { c.font = { ...FONT, bold: true, size: 12 }; });
    const first = w.rowCount + 1;
    for (const id of s.item_ids) {
      const it = e.items.find((x) => x.id === id);
      const r = w.addRow([it.number, `${it.name}${e.areas.length > 1 ? `  [${it.area_tag}]` : ''}${it.excluded ? '  (excluded)' : ''}`, it.qty, it.unit, it.unit_price, null, it.direct]);
      r.getCell(3).numFmt = QTY; r.getCell(5).numFmt = MONEY; r.getCell(7).numFmt = MONEY;
      r.getCell(2).alignment = { wrapText: true, vertical: 'top' };
      for (const a of e.alternates.filter((x) => x.item_id === id)) altRow(a);
    }
    for (const a of e.alternates.filter((x) => x.section_id === s.id && (!x.item_id || !s.item_ids.includes(x.item_id)))) altRow(a);
    const st = w.addRow(['', `Subtotal – ${s.name}`]); bold(st);
    st.getCell(2).alignment = { horizontal: 'right' };
    st.getCell(7).value = { formula: `SUM(G${first}:G${w.rowCount - 1})`, result: s.direct }; st.getCell(7).numFmt = MONEY;
    subRows.push(st.number);
    w.addRow([]);
  }
  const ids = new Set(e.sections.map((s) => s.id));
  for (const a of e.alternates.filter((x) => !x.section_id || !ids.has(x.section_id))) altRow(a);
  const T = e.totals;
  const tot = (label, val, ve) => { const r = w.addRow(['', label]); bold(r); const c = r.getCell(ve ? 6 : 7); c.value = val; c.numFmt = MONEY; return r; };
  const bs = w.addRow(['', 'SUBTOTAL — base estimate (direct cost)']); bold(bs);
  bs.getCell(7).value = { formula: subRows.map((n) => `G${n}`).join('+') || '0', result: T.base_direct }; bs.getCell(7).numFmt = MONEY;
  tot('VE deducts – accepted', T.ve_direct, true);
  tot('Add alternates – accepted', T.add_direct, true);
  tot('Open alternates (proposed / pending, not included)', T.optional_direct, true);
  tot('ADJUSTED ESTIMATE – direct cost', T.grand_direct);
  tot('Markups (see Summary)', T.grand_sell - T.grand_direct);
  tot('GRAND TOTAL – selling price', T.grand_sell);
  w.views = [{ state: 'frozen', ySplit: 5 }]; // title (4 rows) + column headers

  // --- Alternates register
  const ar = sheet(wb, 'Alternates', [9, 13, 11, 40, 10, 7, 13, 15, 15, 15, 15, 40]);
  title(ar, e, 'VE / ALTERNATES REGISTER');
  header(ar, ['No.', 'Type', 'Status', 'Item / Description', 'Qty', 'Unit', 'Unit Price', 'Original (sell)', 'Alternate (sell)', 'Net Change (sell)', 'Net Change (direct)', 'Reason']).height = 30;
  for (const a of e.alternates) {
    const r = ar.addRow([a.tag, a.kind === 'deduct' ? 'VE Deduct' : 'Add Alternate', a.status, `${a.name}${a.item_name ? ` (replaces ${a.item_number} ${a.item_name})` : ''}`,
      a.qty, a.unit, a.unit_price, a.replaces ? a.original_sell : null, a.alt_sell, a.net_sell, a.net_direct, a.reason]);
    [7, 8, 9, 10, 11].forEach((i) => { r.getCell(i).numFmt = MONEY; });
  }
  if (!e.alternates.length) ar.addRow(['', '', '', 'No alternates']);

  // --- Summary
  const s = sheet(wb, 'Summary', [34, 16, 16, 16, 16, 16, 18]);
  title(s, e, 'ESTIMATE SUMMARY');
  for (const g of e.groups) {
    header(s, [g.name, ...TYPES.map((t) => TYPE_NAMES[t]), 'Total']);
    for (const a of g.areas) {
      if (Math.abs(a.direct) < 0.005) continue;
      const r = s.addRow([`${a.tag} – ${a.name} (direct)`, ...TYPES.map((t) => a.costs[t]), a.direct]);
      r.eachCell((c, i) => { if (i > 1) c.numFmt = MONEY; });
    }
    const d = s.addRow(['Direct cost', ...TYPES.map((t) => g.costs[t]), g.direct]); bold(d); d.eachCell((c, i) => { if (i > 1) c.numFmt = MONEY; });
    for (const m of g.markups) {
      const r = s.addRow([`${m.name} (${(m.percent * 100).toFixed(2)}% of ${m.basis === 'running' ? 'running total' : m.basis === 'direct' ? 'direct cost' : TYPE_NAMES[m.basis]})`, ...TYPES.map(() => null), m.amount]);
      r.getCell(TYPES.length + 2).numFmt = MONEY;
    }
    const t = s.addRow([`TOTAL – ${g.name}`, ...TYPES.map(() => null), g.total]); bold(t); t.getCell(TYPES.length + 2).numFmt = MONEY;
    s.addRow([]);
  }

  // --- Cost code × area
  const cc = sheet(wb, 'By Cost Code', [12, 34, ...e.areas.map(() => 16), 18]);
  title(cc, e, 'BASE BID BY COST CODE × POOL / AREA (with markups)');
  header(cc, ['Cost Code', 'Description', ...e.areas.map((a) => `${a.tag} – ${a.name}`), 'Total']);
  const first = cc.rowCount + 1;
  const lastCol = 2 + e.areas.length;
  // Each CSI division gets a subtotal row above its cost codes. SUBTOTAL(9) skips
  // other SUBTOTAL cells, so the grand total counts each cost code once.
  for (const div of e.divisions) {
    const dr = cc.addRow([div.division, `DIVISION ${div.division} – ${div.name.toUpperCase()}`]);
    dr.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } }; });
    bold(dr);
    const dFirst = dr.number + 1;
    for (const row of e.grid.filter((g) => g.division === div.division)) {
      const r = cc.addRow([row.code, row.name, ...e.areas.map((a) => row.cells[a.id].total), null]);
      r.getCell(lastCol + 1).value = { formula: `SUM(${cc.getColumn(3).letter}${r.number}:${cc.getColumn(lastCol).letter}${r.number})` };
      r.eachCell((c, i) => { if (i > 2) c.numFmt = MONEY; });
    }
    for (let i = 3; i <= lastCol + 1; i++) {
      const L = cc.getColumn(i).letter;
      const c = dr.getCell(i); c.value = { formula: `SUBTOTAL(9,${L}${dFirst}:${L}${cc.rowCount})` }; c.numFmt = MONEY;
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } }; c.font = { ...FONT, bold: true };
    }
  }
  const last = cc.rowCount;
  const tr = cc.addRow(['', 'TOTAL']);
  for (let i = 3; i <= lastCol + 1; i++) { const L = cc.getColumn(i).letter; tr.getCell(i).value = { formula: `SUBTOTAL(9,${L}${first}:${L}${last})` }; tr.getCell(i).numFmt = MONEY; }
  bold(tr);

  // --- Detail
  const d = sheet(wb, 'Detail', [10, 14, 16, 40, 8, 6, 12, 13, 15, 26]);
  title(d, e, 'ESTIMATE DETAIL');
  header(d, ['Area', 'Job Cost Code', 'Item Code', 'Description', 'Type', 'Unit', 'Qty', 'Unit Cost', 'Total', 'Bid Group / Source']);
  const sorted = [...e.lines].filter((l) => l.direct !== 0)
    .sort((a, b) => (a.alternate_id || 0) - (b.alternate_id || 0) || a.area_id - b.area_id || a.cost_code_sort - b.cost_code_sort || String(a.item_code).localeCompare(String(b.item_code)));
  const dFirst = d.rowCount + 1;
  for (const l of sorted) {
    const r = d.addRow([l.area_tag, l.job_cost_code, l.item_code, l.description, l.cost_type, l.unit, l.qty, l.unit_cost, l.total,
      `${l.alternate_tag || 'Base'}${l.item_number ? ` · ${l.item_number}` : ''} ${l.estimate_item}${l.adjusted ? ' (price override)' : ''}`]);
    // Lines of overridden items carry their share of the override, so qty × unit cost would not tie
    if (!l.adjusted) r.getCell(9).value = { formula: `ROUND(G${r.number}*H${r.number},2)`, result: l.total };
    r.getCell(7).numFmt = QTY; r.getCell(8).numFmt = MONEY; r.getCell(9).numFmt = MONEY;
  }
  const dt = d.addRow(['', '', '', 'TOTAL DIRECT COST (all groups)']);
  dt.getCell(9).value = { formula: `SUM(I${dFirst}:I${d.rowCount - 1})` }; dt.getCell(9).numFmt = MONEY; bold(dt);
  d.autoFilter = { from: { row: dFirst - 1, column: 1 }, to: { row: dFirst - 1, column: 10 } };
  return wb;
}

// AIA G703-style continuation sheet with live formulas for billing.
function sov(e) {
  const wb = new ExcelJS.Workbook(); wb.creator = 'MC Aquatic Estimator';
  const ws = sheet(wb, 'Schedule of Values', [7, 15, 38, 16, 16, 16, 16, 16, 9, 16, 15]);
  title(ws, e, 'SCHEDULE OF VALUES');
  ws.addRow(['Retainage %', null, 0.10]).getCell(3).numFmt = '0%';
  const retRow = ws.rowCount;
  ws.getCell(`C${retRow}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
  ws.addRow([]);
  header(ws, ['Item', 'Job Cost Code', 'Description of Work', 'Scheduled Value', 'Previous Applications', 'This Period', 'Materials Stored',
    'Total Completed & Stored', '% Complete', 'Balance to Finish', 'Retainage']).height = 32;
  const first = ws.rowCount + 1;
  let n = 0, lastArea = null;
  for (const r of e.sov) {
    if (r.area_id !== lastArea) {
      const ar = ws.addRow(['', '', `${r.area_tag} – ${r.area_name}`]); ar.getCell(3).font = { ...FONT, bold: true, italic: true };
      lastArea = r.area_id;
    }
    const row = ws.addRow([++n, r.job_cost_code, r.description, Math.round(r.value * 100) / 100, 0, 0, 0]);
    const k = row.number;
    row.getCell(8).value = { formula: `E${k}+F${k}+G${k}` };
    row.getCell(9).value = { formula: `IF(D${k}=0,0,H${k}/D${k})` };
    row.getCell(10).value = { formula: `D${k}-H${k}` };
    row.getCell(11).value = { formula: `H${k}*$C$${retRow}` };
    [4, 5, 6, 7, 8, 10, 11].forEach((i) => { row.getCell(i).numFmt = MONEY; });
    [5, 6, 7].forEach((i) => { row.getCell(i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } }; });
    row.getCell(9).numFmt = '0.0%';
  }
  const last = ws.rowCount;
  const t = ws.addRow(['', '', 'GRAND TOTAL']);
  for (const i of [4, 5, 6, 7, 8, 10, 11]) { const L = ws.getColumn(i).letter; t.getCell(i).value = { formula: `SUM(${L}${first}:${L}${last})` }; t.getCell(i).numFmt = MONEY; }
  t.getCell(9).value = { formula: `IF(D${t.number}=0,0,H${t.number}/D${t.number})` }; t.getCell(9).numFmt = '0.0%';
  bold(t);
  ws.addRow([]);
  ws.addRow(['', '', 'Yellow cells are inputs for each pay application. Scheduled values include all markups (allocated per line).']).getCell(3).font = { ...FONT, italic: true };
  ws.views = [{ state: 'frozen', ySplit: first - 1 }];
  return wb;
}

module.exports = { estimate, sov };
