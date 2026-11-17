// Seeds the database with MC Aquatic's division structure, MC_ variables,
// sample items and standard assemblies, plus one demo two-pool project.
// PRICES ARE SAMPLE PLACEHOLDERS — replace them with real MC Aquatic costs.
//
//   node server/seed.js           seed only if the database is empty
//   node server/seed.js --reset   wipe and re-seed
const { open, DB_PATH } = require('./db');
const fs = require('fs');
const { COST_CODES } = require('./csi');
const { createSection, addEstimateItem } = require('./estimate');

const WALL = '(MC_ABOVE_GRADE_WALL_LF+MC_BELOW_GRADE_WALL_LF)';
const WETTED = `(MC_POOL_WATER_SF+(MC_AVG_DEPTH_FT*${WALL}))`;
const REBAR_TN = `ROUNDUP(${WETTED}*0.228*0.668*20/2000,0)`;
const SHOT_CY = '(MC_FLOOR_THICKNESS_IN/12)*MC_POOL_WATER_SF/27+(MC_BELOW_GRADE_WALL_THICKNESS_IN/12)*MC_AVG_DEPTH_FT*MC_BELOW_GRADE_WALL_LF/27+(MC_ABOVE_GRADE_WALL_THICKNESS_IN/12)*MC_AVG_DEPTH_FT*MC_ABOVE_GRADE_WALL_LF/27+MC_STEP_LF*0.04+MC_BENCH_LF*0.17';
const PER_POOL = 'IF(MC_TOTAL_NUMBER_OF_POOLS>0.1,MC_TOTAL_NUMBER_OF_POOLS,1)';
const PLASTER = 'MC_PLASTER_TYPE_ONE_WHT_TWO_QRTZ_THREE_PEB_FOUR_JWL_ZERO_NONE';


// [item_code, description, unit, cost_type, sample unit_cost, CSI MasterFormat cost code]
const ITEMS = [
  ['01.1200.1040', 'Warranty Fee', 'LS', 'O', 1500, '01 78 36'],
  ['01.1200.1050', 'Commission', 'LS', 'O', 2000, '01 31 00'],
  ['01.9410.0050', 'Miscellaneous Materials', 'SF', 'M', 1.0, '01 00 00'],
  ['01.9410.0060', 'General Labor – Budget', 'SF', 'L', 2.0, '01 00 00'],
  ['01.9410.0070', 'Hardware Budget', 'SF', 'M', 1.5, '13 11 46'],
  ['01.9410.0080', 'Layout', 'SF', 'L', 0.35, '01 71 23'],
  ['02.2001.0050', 'Permit Service', 'LS', 'O', 1500, '01 41 26'],
  ['02.2001.0060', 'Permits', 'LS', 'O', 3500, '01 41 26'],
  ['02.2001.0070', '3rd Party Inspections', 'LS', 'S', 4000, '01 45 23'],
  ['02.2001.0080', 'Engineering', 'SF', 'S', 1.25, '01 33 00'],
  ['03.8210.0020', 'Excavation – Base Price', 'LS', 'S', 2500, '31 23 16'],
  ['03.8210.0021', 'Excavation – Variable Price', 'CY', 'S', 22, '31 23 16'],
  ['03.8210.0030', '6" Over Excavation', 'SF', 'S', 1.5, '31 23 16'],
  ['03.8210.0040', 'Haul Off', 'EA', 'S', 450, '31 23 16'],
  ['04.0610.0050', 'Rebar #4 – 20\' Pieces', 'EA', 'M', 9.0, '03 21 00'],
  ['04.0610.0060', 'Rebar Labor', 'TN', 'L', 900, '03 21 00'],
  ['05.0000.0010', 'Plumbing – Base', 'LS', 'S', 8000, '22 51 13'],
  ['05.0000.0020', 'Plumbing – Variable Price', 'SF', 'S', 14, '22 51 13'],
  ['05.0000.0030', 'Long Stub Run', 'LF', 'S', 45, '22 51 13'],
  ['05.0000.0040', 'Perforated Pipe w/ Sock', 'LF', 'S', 12, '33 46 00'],
  ['05.0000.0050', 'Polyurethane Foam 1"', 'SF', 'M', 2.2, '07 21 00'],
  ['05.0000.0060', 'French Drain Budget', 'LS', 'S', 5000, '33 46 00'],
  ['06.0000.0010', 'Shotcrete – Material', 'CY', 'M', 210, '03 37 13'],
  ['06.0000.0011', 'Shotcrete – Placement Labor', 'CY', 'L', 95, '03 37 13'],
  ['06.0000.0020', 'Gunite Watering', 'LS', 'L', 1200, '03 39 00'],
  ['06.0000.0030', 'Shotcrete Pump & Operator', 'DAY', 'E', 1850, '03 37 13'],
  ['07.7001.0140', 'Coping 12x24x2" Lueders', 'LF', 'M', 40, '04 43 00'],
  ['07.7001.0150', 'Coping 14x24x2" Lueders', 'LF', 'M', 46, '04 43 00'],
  ['07.7001.0160', 'Coping 16x24x2" Lueders', 'LF', 'M', 52, '04 43 00'],
  ['07.7001.0170', 'Coping 18x24x2" Lueders', 'LF', 'M', 60, '04 43 00'],
  ['07.7001.0180', 'Coping 24x24x2" Lueders', 'LF', 'M', 78, '04 43 00'],
  ['07.7001.0900', 'Coping – Install Labor', 'LF', 'L', 18, '04 43 00'],
  ['08.7000.0040', 'Waterline Tile – Standard', 'SF', 'S', 38, '09 30 13'],
  ['08.7000.0050', 'Step Tile – Standard', 'SF', 'S', 30, '09 30 13'],
  ['08.7000.0060', 'Ceramic Depth Marker', 'EA', 'M', 45, '09 30 13'],
  ['10.0000.0010', 'Pool Electrical Hookup', 'LS', 'S', 6500, '26 05 00'],
  ['10.0020.0010', 'Light Fixture Budget', 'SF', 'M', 1.75, '26 50 00'],
  ['11.9000.1080', 'System Equipment – Fixed', 'LS', 'M', 15000, '22 51 19'],
  ['11.9000.1090', 'System Equipment – Variable', 'SF', 'M', 9, '22 51 19'],
  ['11.9000.1100', 'ADA Pool Lift – AquaCreek Scout II', 'EA', 'M', 7800, '13 11 46'],
  ['12.9310.0010', 'Plaster Prep', 'SF', 'L', 0.75, '13 11 00'],
  ['12.9310.0020', 'Plaster – White', 'SF', 'S', 5.5, '13 11 00'],
  ['12.9310.0030', 'Plaster – Quartz', 'SF', 'S', 7.25, '13 11 00'],
  ['12.9310.0050', 'Plaster – Pebble Sheen', 'SF', 'S', 9.75, '13 11 00'],
  ['12.9310.0040', 'Plaster – Jewelscapes', 'SF', 'S', 11.5, '13 11 00'],
  ['13.0000.0010', 'Startup & Owner Training', 'LS', 'L', 2500, '01 79 00'],
  ['14.0000.0010', 'Concrete Decking – Integral Color w/ Salt Finish', 'SF', 'S', 10.30, '32 13 13'],
  ['14.0000.0020', 'Concrete Decking – Grey Broom Finish', 'SF', 'S', 8.75, '32 13 13'],
  ['14.0000.0030', 'Concrete Decking – Exposed Aggregate', 'SF', 'S', 9.05, '32 13 13'],
  ['14.0000.0040', 'Concrete Decking – Integral Color Acid Finish', 'SF', 'S', 11.30, '32 13 13'],
  ['14.0000.0090', 'MC-Turndown Beam 12"', 'LF', 'S', 24, '32 13 13'],
  ['14.0000.0100', 'MC-Turndown Beam 18"', 'LF', 'S', 31, '32 13 13'],
  ['15.0000.0030', '8"x8"x16" Concrete Block', 'EA', 'M', 10.25, '04 22 00'],
  ['15.0000.0110', 'CMU Labor per SF', 'SF', 'L', 10, '04 22 00'],
  ['15.0000.0150', 'Stucco + Lath Finish', 'SF', 'S', 10, '09 24 23'],
];

// [name, label, unit, input_type, default, scope, options]
const VARIABLES = [
  ['MC_POOL_WATER_SF', 'Pool water surface area', 'SF', 'number', 0, 'area'],
  ['MC_BELOW_GRADE_WALL_LF', 'Below-grade perimeter wall', 'LF', 'number', 0, 'area'],
  ['MC_ABOVE_GRADE_WALL_LF', 'Above-grade perimeter wall', 'LF', 'number', 0, 'area'],
  ['MC_AVG_DEPTH_FT', 'Average pool depth', 'FT', 'number', 4, 'area'],
  ['MC_FLOOR_THICKNESS_IN', 'Floor shotcrete thickness', 'IN', 'number', 8, 'area'],
  ['MC_BELOW_GRADE_WALL_THICKNESS_IN', 'Below-grade wall thickness', 'IN', 'number', 8, 'area'],
  ['MC_ABOVE_GRADE_WALL_THICKNESS_IN', 'Above-grade wall thickness', 'IN', 'number', 12, 'area'],
  ['MC_STEP_LF', 'Steps', 'LF', 'number', 0, 'area'],
  ['MC_BENCH_LF', 'Benches', 'LF', 'number', 0, 'area'],
  ['MC_DIST_EQUIP_LF', 'Distance to equipment room', 'LF', 'number', 0, 'area'],
  [PLASTER, 'Plaster type', '', 'picklist', 1, 'area',
    [{ value: 0, label: 'None' }, { value: 1, label: 'White' }, { value: 2, label: 'Quartz' }, { value: 3, label: 'Pebble Sheen' }, { value: 4, label: 'Jewelscapes' }]],
  ['MC_COPING_DEPTH_IN', 'Coping depth', 'IN', 'picklist', 12, 'area',
    [{ value: 0, label: 'No coping' }, { value: 12, label: '12"' }, { value: 14, label: '14"' }, { value: 16, label: '16"' }, { value: 18, label: '18"' }, { value: 24, label: '24"' }]],
  ['MC_TOTAL_NUMBER_OF_POOLS', 'Total number of pools on project', 'EA', 'number', 1, 'project'],
];

// assembly name → { code (bid item number), category, description, items: [item_code, label, formula, waste] }
const ASSEMBLIES = {
  'Pool On Grade – Structure': {
    code: '13 11 23.10', category: 'Pool Structure',
    description: 'Layout, excavation, haul-off, shotcrete and rebar for a pool on grade.',
    items: [
      ['01.9410.0080', 'Layout', 'MC_POOL_WATER_SF'],
      ['03.8210.0020', 'Excavation – Base Price', '1'],
      ['03.8210.0021', 'Excavation – Variable (+2 ft over-ex)', 'MC_POOL_WATER_SF*(MC_AVG_DEPTH_FT+2)/27'],
      ['03.8210.0040', 'Haul Off (18 CY trucks)', 'ROUNDUP((MC_POOL_WATER_SF*(MC_AVG_DEPTH_FT+2))/27/18,0)'],
      ['06.0000.0010', 'Shotcrete – Floor', '(MC_FLOOR_THICKNESS_IN/12)*MC_POOL_WATER_SF/27', 0.10],
      ['06.0000.0010', 'Shotcrete – Below Grade Walls', '(MC_BELOW_GRADE_WALL_THICKNESS_IN/12)*MC_AVG_DEPTH_FT*MC_BELOW_GRADE_WALL_LF/27', 0.10],
      ['06.0000.0010', 'Shotcrete – Above Grade Walls', '(MC_ABOVE_GRADE_WALL_THICKNESS_IN/12)*MC_AVG_DEPTH_FT*MC_ABOVE_GRADE_WALL_LF/27', 0.10],
      ['06.0000.0010', 'Shotcrete – Steps', 'MC_STEP_LF*0.04', 0.10],
      ['06.0000.0010', 'Shotcrete – Bench', 'MC_BENCH_LF*0.17', 0.10],
      ['06.0000.0011', 'Shotcrete – Placement Labor (all)', SHOT_CY],
      ['06.0000.0030', 'Shotcrete Pump & Operator (80 CY/day)', `ROUNDUP((${SHOT_CY})/80,0)`],
      ['06.0000.0020', 'Gunite Watering', '1'],
      ['04.0610.0050', 'Rebar #4 Pieces', `${REBAR_TN}*150`],
      ['04.0610.0060', 'Rebar Labor', REBAR_TN],
    ],
  },
  'Pool Plumbing, Equipment & Electrical': {
    code: '22 51 00.10', category: 'Pool Mechanical',
    description: 'Plumbing, mechanical equipment, lights, hardware and electrical hookup.',
    items: [
      ['05.0000.0010', 'Plumbing – Base', '1'],
      ['05.0000.0020', 'Plumbing – Variable', 'MC_POOL_WATER_SF'],
      ['05.0000.0030', 'Long Stub Run', 'MC_DIST_EQUIP_LF'],
      ['11.9000.1080', 'System Equipment – Fixed', '1'],
      ['11.9000.1090', 'System Equipment – Variable', 'MC_POOL_WATER_SF'],
      ['10.0020.0010', 'Light Fixture Budget', 'MC_POOL_WATER_SF'],
      ['01.9410.0070', 'Hardware Budget', 'MC_POOL_WATER_SF'],
      ['10.0000.0010', 'Pool Electrical Hookup', '1'],
      ['11.9000.1100', 'ADA Pool Lift', '1'],
    ],
  },
  'Interior Finish & Tile': {
    code: '13 11 00.10', category: 'Pool Finishes',
    description: 'Plaster prep, plaster by type (picklist), waterline and step tile, depth markers.',
    items: [
      ['12.9310.0010', 'Plaster Prep', WETTED],
      ['12.9310.0020', 'Plaster – White', `IF(${PLASTER}=1,${WETTED},0)`],
      ['12.9310.0030', 'Plaster – Quartz', `IF(${PLASTER}=2,${WETTED},0)`],
      ['12.9310.0050', 'Plaster – Pebble Sheen', `IF(${PLASTER}=3,${WETTED},0)`],
      ['12.9310.0040', 'Plaster – Jewelscapes', `IF(${PLASTER}=4,${WETTED},0)`],
      ['08.7000.0040', 'Waterline Tile (6" band)', `${WALL}/2`],
      ['08.7000.0050', 'Step Tile', '(MC_STEP_LF+MC_BENCH_LF)/3'],
      ['08.7000.0060', 'Depth Markers (1 per 20 LF)', `ROUNDUP(${WALL}/20,0)`],
    ],
  },
  'Coping': {
    code: '04 43 00.10', category: 'Pool Finishes',
    description: 'Fires the coping size chosen in MC_COPING_DEPTH_IN, plus install labor.',
    items: [
      ['07.7001.0140', 'Coping 12"', `IF(MC_COPING_DEPTH_IN=12,${WALL},0)`, 0.05],
      ['07.7001.0150', 'Coping 14"', `IF(MC_COPING_DEPTH_IN=14,${WALL},0)`, 0.05],
      ['07.7001.0160', 'Coping 16"', `IF(MC_COPING_DEPTH_IN=16,${WALL},0)`, 0.05],
      ['07.7001.0170', 'Coping 18"', `IF(AND(MC_COPING_DEPTH_IN>17,MC_COPING_DEPTH_IN<24),${WALL},0)`, 0.05],
      ['07.7001.0180', 'Coping 24"', `IF(MC_COPING_DEPTH_IN>=24,${WALL},0)`, 0.05],
      ['07.7001.0900', 'Coping Install Labor', `IF(MC_COPING_DEPTH_IN>0,${WALL},0)`],
    ],
  },
  'General Conditions & Permits': {
    code: '01 00 00.10', category: 'General Conditions',
    description: 'Permits, engineering, inspections, warranty, commission and general labor.',
    items: [
      ['02.2001.0050', 'Permit Service', '1'],
      ['02.2001.0060', 'Permits', '1'],
      ['02.2001.0070', '3rd Party Inspections', '1'],
      ['02.2001.0080', 'Engineering', 'MC_POOL_WATER_SF'],
      ['01.1200.1040', 'Warranty Fee', '1'],
      ['01.1200.1050', 'Commission', PER_POOL],
      ['01.9410.0060', 'General Labor – Budget', 'MC_POOL_WATER_SF'],
      ['01.9410.0050', 'Miscellaneous Materials', 'MC_POOL_WATER_SF'],
      ['13.0000.0010', 'Startup & Owner Training', '1'],
    ],
  },
  'Structural Upgrade #1 – Drainage': {
    code: '33 46 00.10', category: 'Site Work',
    description: 'Over-excavation, perforated drain pipe, foam and French drain (typical alternate).',
    items: [
      ['03.8210.0030', '6" Over Excavation', 'MC_POOL_WATER_SF'],
      ['05.0000.0040', 'Perforated Pipe w/ Sock', WALL],
      ['05.0000.0050', 'Polyurethane Foam 1"', `${WALL}*MC_AVG_DEPTH_FT`],
      ['05.0000.0060', 'French Drain Budget', '1'],
    ],
  },
};

const DEFAULT_MARKUPS = [
  ['Sales Tax (Material)', 0.0825, 'M'],
  ['Contingency', 0.0, 'direct'],
  ['Overhead', 0.10, 'running'],
  ['Profit', 0.10, 'running'],
  ['Bond', 0.015, 'running'],
];

const DEFAULT_TERMS = 'Proposal valid for 30 days. Payment per approved schedule of values, net 30. Retainage per contract. Price based on drawings and specifications listed above; changes in scope will be priced as change orders.';
const DEFAULT_EXCLUSIONS = 'Rock excavation; dewatering; utilities to equipment room; deck drains beyond the pool perimeter; fencing; landscaping; bonds unless listed; anything not specifically included.';
const DEFAULT_INCLUSIONS = 'Pool layout, excavation and haul-off; shotcrete shell with reinforcing; pool plumbing and mechanical equipment; waterline tile, coping and interior finish; startup and owner training.';

function seed(db) {
  const tx = db.transaction(() => {
    const ccIns = db.prepare('INSERT INTO cost_codes (code, name, sort) VALUES (?, ?, ?)');
    const ccId = {};
    COST_CODES.forEach(([c, n], i) => { ccId[c] = ccIns.run(c, n, i).lastInsertRowid; });

    const itIns = db.prepare('INSERT INTO items (item_code, description, unit, cost_type, unit_cost, cost_code_id, notes) VALUES (?,?,?,?,?,?,?)');
    const itemId = {};
    for (const [code, desc, unit, type, cost, cc] of ITEMS) {
      if (!ccId[cc]) throw new Error(`Item ${code} uses unknown cost code ${cc}`);
      itemId[code] = itIns.run(code, desc, unit, type, cost, ccId[cc], 'Sample price – replace').lastInsertRowid;
    }

    const vIns = db.prepare('INSERT INTO variables (name, label, unit, input_type, options, default_value, scope, sort) VALUES (?,?,?,?,?,?,?,?)');
    VARIABLES.forEach(([n, l, u, t, d, s, o], i) => vIns.run(n, l, u, t, o ? JSON.stringify(o) : null, d, s, i));

    const aIns = db.prepare("INSERT INTO assemblies (name, code, category, unit, description) VALUES (?, ?, ?, 'LS', ?)");
    const aiIns = db.prepare('INSERT INTO assembly_items (assembly_id, item_id, label, formula, waste_pct, sort) VALUES (?,?,?,?,?,?)');
    const asmId = {};
    for (const [name, a] of Object.entries(ASSEMBLIES)) {
      asmId[name] = aIns.run(name, a.code, a.category, a.description).lastInsertRowid;
      a.items.forEach(([code, label, f, w], i) => aiIns.run(asmId[name], itemId[code], label, f, w || 0, i));
    }

    // ---- Demo project: two pools + site-wide
    const pid = db.prepare(`INSERT INTO projects (name, number, client, gc, location, bid_date, estimator, inclusions, exclusions, terms)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run('SAMPLE – Two-Pool Amenity Center', '26-000', 'Sample Owner LLC', 'Sample GC', 'Austin, TX',
      '2026-11-15', 'MC Aquatic', DEFAULT_INCLUSIONS, DEFAULT_EXCLUSIONS, DEFAULT_TERMS).lastInsertRowid;
    const arIns = db.prepare('INSERT INTO areas (project_id, tag, name, sort) VALUES (?,?,?,?)');
    const p1 = arIns.run(pid, 'P1', 'Main Pool', 1).lastInsertRowid;
    const p2 = arIns.run(pid, 'P2', 'Activity Pool', 2).lastInsertRowid;
    const gen = arIns.run(pid, 'GEN', 'Site-wide / General', 99).lastInsertRowid;
    const alt1 = db.prepare('INSERT INTO alternates (project_id, tag, name, kind, sort) VALUES (?,?,?,?,?)')
      .run(pid, 'ALT 1', 'Structural Upgrade #1 – Main Pool drainage', 'add', 1).lastInsertRowid;

    const varId = Object.fromEntries(db.prepare('SELECT name, id FROM variables').all().map((v) => [v.name, v.id]));
    const vv = db.prepare('INSERT INTO var_values (project_id, area_id, variable_id, value) VALUES (?,?,?,?)');
    const setVars = (area, obj) => Object.entries(obj).forEach(([k, v]) => vv.run(pid, area, varId[k], v));
    setVars(0, { MC_TOTAL_NUMBER_OF_POOLS: 2 });
    setVars(p1, { MC_POOL_WATER_SF: 3200, MC_BELOW_GRADE_WALL_LF: 240, MC_ABOVE_GRADE_WALL_LF: 0, MC_AVG_DEPTH_FT: 4.5,
      MC_STEP_LF: 40, MC_BENCH_LF: 30, MC_DIST_EQUIP_LF: 60, [PLASTER]: 2, MC_COPING_DEPTH_IN: 16 });
    setVars(p2, { MC_POOL_WATER_SF: 1300, MC_BELOW_GRADE_WALL_LF: 150, MC_ABOVE_GRADE_WALL_LF: 0, MC_AVG_DEPTH_FT: 3,
      MC_STEP_LF: 24, MC_BENCH_LF: 0, MC_DIST_EQUIP_LF: 30, [PLASTER]: 3, MC_COPING_DEPTH_IN: 12 });

    // Worksheet: sections → bid items placed per pool. Components are copied from the database.
    const sec = {};
    ['GENERAL CONDITIONS', 'POOL', 'PLUMBING & EQUIPMENT', 'INTERIOR FINISH, TILE & COPING', 'DECKING'].forEach((n, i) => { sec[n] = createSection(db, pid, n, i + 1); });
    const add = (section, area, d) => addEstimateItem(db, { project_id: pid, section_id: sec[section], area_id: area, ...d });
    add('GENERAL CONDITIONS', gen, { assembly_id: asmId['General Conditions & Permits'] });
    for (const [area, tag] of [[p1, 'Main Pool'], [p2, 'Activity Pool']]) {
      add('POOL', area, { assembly_id: asmId['Pool On Grade – Structure'], name: `Pool Structure – ${tag}` });
      add('PLUMBING & EQUIPMENT', area, { assembly_id: asmId['Pool Plumbing, Equipment & Electrical'], name: `Plumbing, Equipment & Electrical – ${tag}` });
      add('INTERIOR FINISH, TILE & COPING', area, { assembly_id: asmId['Interior Finish & Tile'], name: `Interior Finish & Tile – ${tag}` });
      add('INTERIOR FINISH, TILE & COPING', area, { assembly_id: asmId.Coping, name: `Coping – ${tag}` });
    }
    const deck = add('DECKING', gen, { item_id: itemId['14.0000.0010'], qty: 2800, notes: 'Pool deck by sub' });

    // Alternates register: an add alternate priced in detail, and a VE deduct that replaces the deck finish
    db.prepare('UPDATE alternates SET section_id = ?, status = ?, reason = ? WHERE id = ?')
      .run(sec.POOL, 'proposed', 'Geotech report flags expansive clay at the main pool.', alt1);
    add('POOL', p1, { assembly_id: asmId['Structural Upgrade #1 – Drainage'], alternate_id: alt1 });
    db.prepare(`INSERT INTO alternates (project_id, tag, name, kind, status, section_id, item_id, replaces, bid_item_no, description, qty, unit, unit_price, cost_type, reason, sort)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(pid, 'VE 1', 'Grey broom finish in lieu of integral color salt finish', 'deduct', 'pending', sec.DECKING, deck, 1, '14.0000.0020',
        'Pool deck finish change, same area.', 2800, 'SF', 8.75, 'S', 'Owner budget reduction.', 2);

    const mk = db.prepare('INSERT INTO markups (project_id, name, percent, basis, sort) VALUES (?,?,?,?,?)');
    DEFAULT_MARKUPS.forEach(([n, p, b], i) => mk.run(pid, n, p, b, i));
  });
  tx();
}

module.exports = { seed, ITEMS, ASSEMBLIES, DEFAULT_MARKUPS, DEFAULT_TERMS, DEFAULT_EXCLUSIONS, DEFAULT_INCLUSIONS };

if (require.main === module) {
  const reset = process.argv.includes('--reset');
  if (reset) for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f);
  const db = open();
  const n = db.prepare('SELECT COUNT(*) n FROM cost_codes').get().n;
  if (n && !reset) console.log('Database already has data — use --reset to wipe and re-seed.');
  else { seed(db); console.log(`Seeded ${DB_PATH}`); }
}
