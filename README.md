# MC Aquatic Estimator

Estimating software for commercial pool work, modeled on how MC Aquatic uses Pro-Est:

- **Cost code database (CSI MasterFormat).** There's one master list of cost codes, numbered by CSI MasterFormat 2018 sections (`03 37 13` Shotcrete, `22 51 13` Swimming Pool Piping, `31 23 16` Excavation…). The first two digits are the division, and the Summary, SOV and Excel export subtotal by division. Items are linked to a code by ID, so if you change a code, every estimate, summary, SOV and export updates.
- **Multiple pools per project.** Each pool or area (P1, P2, SPA, GEN…) is priced on its own using the **same cost codes**. Job cost codes get the pool tag added (`03 37 13-P1`, `03 37 13-P2`).
- **Assemblies with `MC_` variables.** These work like Pro-Est formulas (`IF`, `AND`, `ROUNDUP`…). Quantities are calculated from each pool's takeoff values. Each assembly is a reusable **bid item** with its own bid item number.
- **L / M / E / S / O cost types and markups.** Markups (sales tax on material, contingency, overhead, profit, bond) can be configured and applied in order. Each one is based on one cost type, the total direct cost, or the running total.
- **Estimate worksheet.** Sections (1 POOL, 2 HARDSCAPES …) → bid items numbered per section (1.1, 1.2, 2.1 …) → expandable components, with a subtotal per section and an overall subtotal, with inline editing, autosave, undo and a separate *VE Deduct / Add Alternate* column left of *Base Estimate Cost*.
- **VE / alternates register.** VE deducts and add alternates with status (Proposed, Pending, Accepted, Rejected, Excluded). Only accepted ones change the total; a replacement is priced as the net difference from the original item.
- **Revisions.** Issue Rev 0, Rev 1 … as frozen snapshots; see what changed, who changed it and when.
- **Outputs.** Summary by cost code × pool, Schedule of Values (Excel export in AIA G703 format with live pay-app formulas), detailed estimate export to Excel, and a printable proposal.

> ⚠️ **The prices in the starter data are placeholders.** The division structure, item codes, variables and formulas come from MC Aquatic's Pro-Est setup. The unit costs are made up. Replace them before you bid anything (use **Items → Paste from Excel**).

---

## Quick start

Requires **Node.js 20 or newer**.

```bash
npm run install:all     # installs server + client dependencies
npm run build           # builds the web app
npm start               # http://localhost:3000
```

On first start, an empty database is filled with MC Aquatic's starter data and a sample two-pool project.
The database is a single SQLite file: `data/estimator.db`. Set `MCA_DB=/path/to/file.db` to put it somewhere else, and `PORT` to change the port.

**Development** (live reload): run `npm run dev` (API on :3000) and `npm run dev:client` (web app on :5173, proxies `/api`).

**Tests:** `npm test` checks the formula engine, markup math, that multi-pool totals tie out, that cost-code changes flow through, and the API.

**Back up:** `npm run backup` writes a complete copy to `data/backup/`. Don't copy `estimator.db` by hand: the database runs in WAL mode and recent changes live in `estimator.db-wal`. The app also backs itself up automatically before any upgrade that restructures tables.

**Reset to starter data:** `npm run seed` (this wipes the database).

**Upgrading an older database** (one that still uses the MC two-digit divisions 01–18): `npm run migrate:csi`. It adds the MasterFormat codes, moves every item onto its new code, removes the old division codes, and leaves bid totals unchanged. Safe to run more than once.

### Run in Docker

```bash
docker build -t mca-estimator .
docker run -p 3000:3000 -v mca-data:/app/data mca-estimator
```

---

## How to use it

1. **Database → Cost Codes.** The starter list is pool-relevant MasterFormat sections. Paste more from Excel (columns `code`, `name`); `033713`, `03-37-13` and `03.37.13` are all saved as `03 37 13`. If you edit a code later, the change shows up everywhere.
2. **Database → Items.** Paste items (`item_code, description, unit, cost_type, unit_cost, cost_code`). `cost_type` is L, M, S or O (or Labor/Material/…).
3. **Database → Variables / Assemblies.** Build assemblies from items and quantity formulas. Use **Test values** to check the math before using an assembly on a bid.
4. **Projects → New project.** Pick how many pools. Then:
   - **Setup:** rename pools, add areas (Spa, Site-wide), add alternates, adjust markups.
   - **Takeoff Variables:** enter each pool's plan quantities (water SF, wall LF, depth, plaster type, coping size…).
   - **Estimate:** at the top, the always-visible **ITEM ENTRY** panel: search the item database (number, description, cost code, cost type, category), pick an item, choose **ASSIGN TO BID ITEM**, enter quantity / unit / unit cost (extended cost shows live) and click **+ ADD TO BID ITEM**; keep going without leaving the screen. **+ New Bid Item** adds an empty parent bid item (BI-001, BI-002 …, $0.00) at the bottom of the worksheet for you to describe. Click **+** on a bid item to see its components (item no., description, cost type, qty, unit, unit cost, extended) and edit, re-type, move or remove them. The worksheet subtotal is the sum of the parent Base Prices only. **+ Bid Item from Assembly** searches the bid item database (assemblies and items) by number, name, description, category or keyword; pick one or many, choose the section and pool, edit description / qty / unit / price, and add. Click **+** left of a bid item number to see and edit its components. Columns are Cost-code, +, Bid Item Number, Description (wraps to as many lines as needed), $ VE Deduct / ADD ALT and $ Base Price; quantity, unit and unit price are in the + panel. Click a description, base price or any field in the + panel to edit it in place (Enter saves, Esc cancels; overrides are shaded yellow, ↺ resets). **+ Add Alternate** creates a VE deduct or add alternate. **Cost / Sell** switches between internal direct cost and selling price. Enter your name under *Estimator* so the change log knows who made each change. Ctrl+Z undoes the last change. **Revisions** issues Rev 0, Rev 1 …
   - **Summary / Schedule of Values / Proposal:** review, export to Excel, and print the proposal to PDF.

### How the numbers work

- **Component qty** = formula result × (1 + waste %), using the pool's variable values. A pool value overrides the project value, which overrides the variable's default.
- **Bid item unit price** = Σ (component qty × unit cost), per 1 unit of the bid item. **Base estimate cost** = qty × unit price. A unit price you type is an override; a base cost you type is a lump sum.
- **Prices are copied into the estimate** when a bid item is added. Editing the database later never changes an existing estimate; the worksheet flags changed prices and *Re-sync with database* pulls them in on request.
- **Alternates.** Net change = alternate price − original item (replacement), or ± the alternate price. Base estimate never includes alternates. Adjusted (grand) total = base − accepted VE deducts + accepted add alternates. Proposed and pending alternates appear as *Optional items* only.
- **Money is exact.** All amounts are integer cents; quantities × prices are multiplied as scaled integers and rounded once (half away from zero). See `server/money.js`.
- **Markups** are applied top to bottom. Each one is a % of one cost type (e.g. tax on Material), of total direct cost, or of the *running total* (direct cost plus the markups above it, so they compound). Each markup is calculated once per bid group and then allocated to every component line to the cent (largest remainder), so sections, pools, cost codes, divisions and SOV lines always add up exactly to the bid total.
- **Formula language:** `+ - * / ^ ( )`, comparisons `= <> < <= > >=`, and the functions `IF AND OR NOT ROUNDUP ROUNDDOWN ROUND CEILING FLOOR MIN MAX ABS`. Dividing by zero returns 0. The engine is a small custom parser; it never `eval`s formula text.

### Things to check against Pro-Est

- **Per-pool vs. per-project items.** In Pro-Est, one Pool On Grade assembly often covers every pool and uses `MC_TOTAL_NUMBER_OF_POOLS` to multiply base prices. Here, the assembly is placed once **per pool**, so pool-level base prices (excavation base, plumbing base, ADA lift) use `1`. Commission stays per-pool in the Site-wide General Conditions assembly.
- **Formulas without full parentheses.** A few formulas in the Pro-Est catalog were written without full parentheses (waterline tile, step tile, depth markers, foam). The seed uses the parenthesized intent, e.g. `(ABOVE_LF + BELOW_LF)/2`. Check these with an estimator.
- **Shotcrete items.** Shotcrete is split into Material (with 10% waste) and Placement Labor (no waste) as an example of L/M breakdown.

---

## Project layout

```
server/
  index.js      start-up (opens DB, seeds if empty, serves API + web app)
  app.js        REST API (Express)
  money.js      exact cents arithmetic and allocation
  estimate.js   adding bid items (copying components), re-sync from database
  migrate.js    idempotent schema migrations run on start-up
  calc.js       estimate engine: assemblies → lines → rollups, markups, cost code × pool grid, CSI division rollup, SOV
  csi.js        CSI MasterFormat divisions + starter cost code list
  migrate-csi.js  moves an older database from MC divisions 01–18 to MasterFormat codes
  formula.js    safe formula parser/evaluator
  export.js     Excel exports (estimate, SOV/G703)
  schema.sql    SQLite schema
  seed.js       MC Aquatic starter data + sample project
  test/         node:test suite
client/         React (Vite) web app
  src/pages/    Projects, project tabs (Setup, Takeoff, Estimate, Summary, SOV, Proposal), database screens
```

### Data model

`cost_codes` ← `items` (L/M/E/S/O, unit cost) ← `assembly_items` (formula, waste) → `assemblies`
`projects` → `areas` (pools) · `alternates` · `markups` · `var_values` (per pool / per project)
`estimate_sections` → `estimate_items` (bid item placed in a pool; `alternate_id` set = priced inside that alternate) → `estimate_components` (copied lines + price snapshot)
`alternates` (VE / alternate register) · `estimate_revisions` (frozen snapshots) · `estimate_log` (who changed what, when)
Legacy `assembly_instances` / `instance_overrides` / `lines` are kept but no longer used; `server/migrate.js` copies them into the worksheet tables once (totals unchanged).

## Not built yet (natural next steps)

- User logins and permissions (anyone who can reach the server can currently edit everything; the change log records the name each estimator types in, not a verified identity). Put it behind your VPN/SSO, or add auth, before exposing it to the internet.
- On-screen PDF takeoff (Bluebeam/PlanSwift-style). Quantities are typed in for now.
- Crew/labor-hour production rates, and price history for the item database.
- Import of existing Pro-Est databases (export from Pro-Est to Excel, then use Paste from Excel).
