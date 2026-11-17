# Handoff: MC Aquatic Estimator — context for a new Claude chat

Paste this into a new chat and attach `mca-estimator.zip` (and `MCA_Bid_Template_Cost_Codes.xlsx` if needed).

## What this is
An estimating app for commercial pool construction, similar to Autodesk Pro-Est. Built for MC Aquatic.
The stack is Node.js + Express + SQLite (better-sqlite3) on the server, with a React (Vite) web app. See README.md in the zip.

## Requirements so far
1. **Cost codes live in one database table** and use CSI MasterFormat 2018 numbering (`DD SS SS`), with subtotals by division. Items reference cost codes by ID, so changing a code updates every estimate, summary, SOV and export. (This started as an Excel template that used VLOOKUP.)
2. **Multiple pools per project.** Each pool or area (P1, P2, GEN…) is tracked separately using the SAME cost codes. Job cost code = cost code + pool tag, e.g. `03 37 13-P1`, `03 37 13-P2`.
3. **Assemblies with MC_ variables.** These follow Pro-Est formula style (IF, AND, ROUNDUP…). Takeoff values are entered per pool.
4. **Cost types and markups.** Each item is L/M/E/S/O (Labor, Material, Equipment, Subcontractor, Other). Markups are configurable and applied in order: tax on material, contingency, overhead, profit, bond. Base bid plus add/deduct alternates.
5. **Outputs.** Summary by cost code × pool, Schedule of Values (Excel export in G703 format), detailed estimate export to Excel, and a printable proposal.

6. **Estimate worksheet (redesign).** One flat list of numbered bid items (columns: Cost-code, +, Bid Item Number, wrapping Description, $ VE Deduct / ADD ALT, $ Base Price) with one subtotal → expandable components. Sections still exist in the database as an internal grouping but are not shown; inline editing with autosave, retry and undo; separate VE Deduct / Add Alternate column left of Base Estimate Cost; Cost / Sell views.
7. **VE / alternates register** with statuses; only accepted alternates change the adjusted total; replacements priced as net difference.
8. **Revisions** (Rev 0, Rev 1 …) as frozen snapshots plus a change log (who / what / when).
9. **Bid item database stays separate from project estimates:** adding a bid item copies its components and prices, so database edits never change existing estimates.

10. **ProEst-style item entry.** Always-visible ITEM ENTRY panel adds database items as child components of an explicitly chosen parent bid item; + New Bid Item creates an empty parent (BI-###). Components keep snapshots of description, unit, cost type and unit cost, and can be moved between parents.

11. **Sections and section-based numbering.** Five-column worksheet (+, Bid Item Number, Description, VE, Base Price; no cost code column) with section header rows and section subtotals. `estimate_sections.number` and `estimate_items.item_sequence` are separate integers with UNIQUE(project_id, number) and UNIQUE(section_id, item_sequence); the displayed "1.2" is built as text. Numbers are never reused or renumbered on delete; moving an item to another section gives it the next number there.

## Current state
- Everything above works. 19 automated tests pass (`npm test`), and the worksheet workflow was checked end to end in the browser. Money is exact integer-cent math (`server/money.js`).
- **Starter data:** CSI MasterFormat cost codes (server/csi.js; older databases upgrade with `npm run migrate:csi`), item codes, MC_ variables, 6 assemblies, and a sample two-pool project. **Unit prices are placeholders.**
- **Pool-level base items use qty 1 per pool.** Each assembly is placed once per pool, so excavation base, plumbing base and the ADA lift are not multiplied by MC_TOTAL_NUMBER_OF_POOLS.
- **Formulas to confirm with an estimator:** waterline tile, step tile, depth markers and foam (parentheses were unclear in the Pro-Est catalog).

## Next steps
- Load the real MC Aquatic cost codes and prices (use Items → Paste from Excel).
- Add user logins before hosting outside the office network.
- Possible later: on-screen PDF takeoff, crew/labor production rates, price history.

## Run it
```
npm run install:all && npm run build && npm start   # http://localhost:3000
```
