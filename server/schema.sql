-- MC Aquatic Estimator — SQLite schema
PRAGMA foreign_keys = ON;

-- ============ DATABASE (shared across all projects) ============

-- Master cost codes. Items point at cost_codes.id, so editing a code here
-- updates every item, estimate line, summary, SOV and proposal automatically.
CREATE TABLE IF NOT EXISTS cost_codes (
  id        INTEGER PRIMARY KEY,
  code      TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL,
  sort      INTEGER NOT NULL DEFAULT 0
);

-- Database items. One cost type each: L=Labor M=Material E=Equipment S=Subcontractor O=Other.
CREATE TABLE IF NOT EXISTS items (
  id            INTEGER PRIMARY KEY,
  item_code     TEXT NOT NULL,
  description   TEXT NOT NULL,
  unit          TEXT NOT NULL DEFAULT 'EA',
  cost_type     TEXT NOT NULL DEFAULT 'M' CHECK (cost_type IN ('L','M','E','S','O')),
  unit_cost     REAL NOT NULL DEFAULT 0,
  cost_code_id  INTEGER REFERENCES cost_codes(id) ON DELETE SET NULL,
  notes         TEXT,
  active        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_items_code ON items(cost_code_id);

-- Takeoff / input variables used by assembly formulas (MC_ prefix convention).
-- scope 'area' = entered per pool/area; 'project' = one value for the whole job.
CREATE TABLE IF NOT EXISTS variables (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  label          TEXT NOT NULL,
  unit           TEXT,
  input_type     TEXT NOT NULL DEFAULT 'number' CHECK (input_type IN ('number','picklist')),
  options        TEXT,          -- JSON [{ "value": 1, "label": "White" }, ...] for picklists
  default_value  REAL NOT NULL DEFAULT 0,
  scope          TEXT NOT NULL DEFAULT 'area' CHECK (scope IN ('area','project')),
  sort           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS assemblies (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT
);

CREATE TABLE IF NOT EXISTS assembly_items (
  id           INTEGER PRIMARY KEY,
  assembly_id  INTEGER NOT NULL REFERENCES assemblies(id) ON DELETE CASCADE,
  item_id      INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  label        TEXT,                 -- e.g. "Shotcrete – Floor" (defaults to item description)
  formula      TEXT NOT NULL DEFAULT '1',
  waste_pct    REAL NOT NULL DEFAULT 0,
  sort         INTEGER NOT NULL DEFAULT 0
);

-- ============ PROJECTS ============

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  number      TEXT,
  client      TEXT,
  gc          TEXT,
  location    TEXT,
  bid_date    TEXT,
  estimator   TEXT,
  status      TEXT NOT NULL DEFAULT 'Estimating',
  inclusions  TEXT,
  exclusions  TEXT,
  terms       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Pools / areas within a project (Main Pool, Activity Pool, Spa, Site-wide ...)
CREATE TABLE IF NOT EXISTS areas (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tag         TEXT NOT NULL,   -- appended to cost codes for job costing, e.g. P1
  name        TEXT NOT NULL,
  sort        INTEGER NOT NULL DEFAULT 0,
  UNIQUE (project_id, tag)
);

-- Alternates / options priced separately from the base bid.
-- Extra columns (status, section_id, item_id, replaces, qty, unit_price, reason ...) are
-- added by migrate.js so existing databases upgrade in place; the same goes for
-- assemblies.code / category / unit and projects.estimate_name.
CREATE TABLE IF NOT EXISTS alternates (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tag         TEXT NOT NULL,   -- ALT 1
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'add' CHECK (kind IN ('add','deduct')),
  sort        INTEGER NOT NULL DEFAULT 0
);

-- Variable values. area_id = 0 means project-level value.
CREATE TABLE IF NOT EXISTS var_values (
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  area_id      INTEGER NOT NULL DEFAULT 0,
  variable_id  INTEGER NOT NULL REFERENCES variables(id) ON DELETE CASCADE,
  value        REAL NOT NULL,
  PRIMARY KEY (project_id, area_id, variable_id)
);

-- Markups applied in sort order. basis:
--   L / M / E / S / O  -> percent of that cost type's direct cost (e.g. sales tax on Material)
--   direct         -> percent of total direct cost
--   running        -> percent of the running total so far (direct + earlier markups)
CREATE TABLE IF NOT EXISTS markups (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  percent     REAL NOT NULL DEFAULT 0,  -- stored as a fraction: 0.10 = 10%
  basis       TEXT NOT NULL DEFAULT 'running' CHECK (basis IN ('L','M','E','S','O','direct','running')),
  sort        INTEGER NOT NULL DEFAULT 0
);

-- An assembly placed in a pool/area. Its lines are calculated live from the
-- assembly formulas + that area's variable values (never stored), so changing
-- a variable, formula, price or cost code re-prices the estimate immediately.
CREATE TABLE IF NOT EXISTS assembly_instances (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  area_id       INTEGER NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
  assembly_id   INTEGER NOT NULL REFERENCES assemblies(id) ON DELETE CASCADE,
  alternate_id  INTEGER REFERENCES alternates(id) ON DELETE CASCADE,
  sort          INTEGER NOT NULL DEFAULT 0
);

-- Per-instance tweaks to a calculated assembly line.
CREATE TABLE IF NOT EXISTS instance_overrides (
  instance_id        INTEGER NOT NULL REFERENCES assembly_instances(id) ON DELETE CASCADE,
  assembly_item_id   INTEGER NOT NULL REFERENCES assembly_items(id) ON DELETE CASCADE,
  qty                REAL,
  unit_cost          REAL,
  excluded           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (instance_id, assembly_item_id)
);

-- Manually entered estimate lines.
CREATE TABLE IF NOT EXISTS lines (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  area_id       INTEGER NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
  alternate_id  INTEGER REFERENCES alternates(id) ON DELETE CASCADE,
  item_id       INTEGER NOT NULL REFERENCES items(id),
  description   TEXT,            -- optional override of item description
  qty           REAL NOT NULL DEFAULT 0,
  unit_cost     REAL,            -- NULL = use database price
  notes         TEXT,
  sort          INTEGER NOT NULL DEFAULT 0
);

-- ============ ESTIMATE WORKSHEET (v2) ============
-- Replaces assembly_instances / instance_overrides / lines (kept for legacy data;
-- existing estimates are copied into these tables once by migrate.js).
--
-- Three separate concepts:
--   Bid item database   assemblies / assembly_items / items (reusable masters)
--   Project estimate    estimate_sections → estimate_items → estimate_components
--                       (components are COPIED from the database when added, so
--                       later database edits never change an existing estimate)
--   VE / alternates     alternates (+ estimate_items with alternate_id for detailed pricing)

CREATE TABLE IF NOT EXISTS schema_migrations (
  name        TEXT PRIMARY KEY,
  applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Level 1: major worksheet sections (POOL, DECKING, HARDSCAPES ...)
CREATE TABLE IF NOT EXISTS estimate_sections (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  sort        INTEGER NOT NULL DEFAULT 0
);

-- Level 2: estimate items. Unit price = sum of its components per 1 unit, unless
-- overridden; base cost = qty × unit price, unless a lump-sum total is entered.
CREATE TABLE IF NOT EXISTS estimate_items (
  id              INTEGER PRIMARY KEY,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  section_id      INTEGER NOT NULL REFERENCES estimate_sections(id) ON DELETE CASCADE,
  area_id         INTEGER NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
  alternate_id    INTEGER REFERENCES alternates(id) ON DELETE CASCADE,  -- set = priced inside that alternate, not the base bid
  assembly_id     INTEGER REFERENCES assemblies(id) ON DELETE SET NULL, -- source assembly (traceability only)
  bid_item_no     TEXT,
  name            TEXT NOT NULL,
  description     TEXT,
  notes           TEXT,
  qty             REAL NOT NULL DEFAULT 1,
  unit            TEXT NOT NULL DEFAULT 'LS',
  unit_price      REAL,        -- per-unit override; NULL = built up from components
  total_override  REAL,        -- lump-sum override of the base cost
  excluded        INTEGER NOT NULL DEFAULT 0,
  sort            INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at      TEXT         -- soft delete, so a removal can be undone
);
CREATE INDEX IF NOT EXISTS ix_estimate_items_project ON estimate_items(project_id);

-- Level 3: components of an estimate item (copied from the assembly / item).
CREATE TABLE IF NOT EXISTS estimate_components (
  id                INTEGER PRIMARY KEY,
  estimate_item_id  INTEGER NOT NULL REFERENCES estimate_items(id) ON DELETE CASCADE,
  item_id           INTEGER NOT NULL REFERENCES items(id),
  assembly_item_id  INTEGER,   -- the assembly line it was copied from (no FK: the master may change)
  label             TEXT,
  formula           TEXT NOT NULL DEFAULT '1',  -- qty per 1 unit of the estimate item
  waste_pct         REAL NOT NULL DEFAULT 0,
  qty               REAL,      -- override of the formula result
  unit_cost         REAL NOT NULL DEFAULT 0,  -- price snapshot
  excluded          INTEGER NOT NULL DEFAULT 0,
  sort              INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_estimate_components_item ON estimate_components(estimate_item_id);

-- Issued estimate revisions (Rev 0, Rev 1 ...). data = frozen JSON snapshot.
CREATE TABLE IF NOT EXISTS estimate_revisions (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  rev         INTEGER NOT NULL,
  label       TEXT,
  note        TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  data        TEXT NOT NULL,
  UNIQUE (project_id, rev)
);

-- Change log: what changed, who changed it, when.
CREATE TABLE IF NOT EXISTS estimate_log (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  at          TEXT NOT NULL DEFAULT (datetime('now')),
  user        TEXT,
  action      TEXT NOT NULL,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS ix_estimate_log_project ON estimate_log(project_id, id);
