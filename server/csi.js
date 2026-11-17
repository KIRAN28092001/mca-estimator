// CSI MasterFormat 2018 structure: divisions (first two digits) and the cost codes
// (MasterFormat section numbers) used for commercial pool work.
// Cost codes are written "DD SS SS", e.g. "03 37 13" = Division 03 Concrete › Shotcrete.

const DIVISIONS = {
  '00': 'Procurement and Contracting Requirements',
  '01': 'General Requirements',
  '02': 'Existing Conditions',
  '03': 'Concrete',
  '04': 'Masonry',
  '05': 'Metals',
  '06': 'Wood, Plastics, and Composites',
  '07': 'Thermal and Moisture Protection',
  '08': 'Openings',
  '09': 'Finishes',
  '10': 'Specialties',
  '11': 'Equipment',
  '12': 'Furnishings',
  '13': 'Special Construction',
  '14': 'Conveying Equipment',
  '21': 'Fire Suppression',
  '22': 'Plumbing',
  '23': 'Heating, Ventilating, and Air Conditioning (HVAC)',
  '25': 'Integrated Automation',
  '26': 'Electrical',
  '27': 'Communications',
  '28': 'Electronic Safety and Security',
  '31': 'Earthwork',
  '32': 'Exterior Improvements',
  '33': 'Utilities',
  '34': 'Transportation',
  '35': 'Waterway and Marine Construction',
  '40': 'Process Interconnections',
  '41': 'Material Processing and Handling Equipment',
  '42': 'Process Heating, Cooling, and Drying Equipment',
  '43': 'Process Gas and Liquid Handling, Purification, and Storage Equipment',
  '44': 'Pollution and Waste Control Equipment',
  '45': 'Industry-Specific Manufacturing Equipment',
  '46': 'Water and Wastewater Equipment',
  '48': 'Electrical Power Generation',
};

// [code, name] — pool-relevant MasterFormat sections, in division order.
const COST_CODES = [
  ['01 00 00', 'General Requirements – General Labor & Materials'],
  ['01 31 00', 'Project Management and Coordination'],
  ['01 33 00', 'Submittals & Delegated Design (Engineering)'],
  ['01 41 26', 'Permits'],
  ['01 45 23', 'Testing and Inspecting Services'],
  ['01 50 00', 'Temporary Facilities and Controls'],
  ['01 71 13', 'Mobilization'],
  ['01 71 23', 'Field Engineering / Layout'],
  ['01 74 00', 'Cleaning and Waste Management'],
  ['01 78 36', 'Warranties'],
  ['01 79 00', 'Demonstration and Training (Startup)'],
  ['02 41 00', 'Demolition'],
  ['03 10 00', 'Concrete Forming and Accessories'],
  ['03 21 00', 'Reinforcement Bars'],
  ['03 30 00', 'Cast-in-Place Concrete'],
  ['03 37 13', 'Shotcrete'],
  ['03 39 00', 'Concrete Curing'],
  ['04 22 00', 'Concrete Unit Masonry'],
  ['04 43 00', 'Stone Masonry (Coping)'],
  ['05 52 00', 'Metal Railings'],
  ['07 10 00', 'Dampproofing and Waterproofing'],
  ['07 21 00', 'Thermal Insulation'],
  ['07 92 00', 'Joint Sealants'],
  ['09 24 23', 'Cement Stucco'],
  ['09 30 13', 'Ceramic Tiling'],
  ['10 30 00', 'Fireplaces and Stoves (Fire Features)'],
  ['11 40 00', 'Foodservice Equipment (Outdoor Kitchens)'],
  ['13 11 00', 'Swimming Pools – Plaster / Interior Finish'],
  ['13 11 46', 'Swimming Pool Accessories'],
  ['13 12 00', 'Fountains / Water Features'],
  ['22 51 13', 'Swimming Pool Piping'],
  ['22 51 19', 'Swimming Pool Water Treatment Equipment'],
  ['26 05 00', 'Common Work Results for Electrical'],
  ['26 05 26', 'Grounding and Bonding'],
  ['26 50 00', 'Lighting'],
  ['31 23 16', 'Excavation'],
  ['31 23 19', 'Dewatering'],
  ['31 23 23', 'Fill / Backfill'],
  ['32 13 13', 'Concrete Paving (Decking)'],
  ['32 14 00', 'Unit Paving'],
  ['32 31 00', 'Fences and Gates'],
  ['32 90 00', 'Planting'],
  ['33 46 00', 'Subdrainage'],
];

// Old MC two-digit divisions → closest MasterFormat code (used by the migration
// for items that are not in the starter item list).
const LEGACY_DIVISIONS = {
  '01': '01 00 00', '02': '01 41 26', '03': '31 23 16', '04': '03 21 00', '05': '22 51 13', '06': '03 37 13',
  '07': '04 43 00', '08': '09 30 13', '09': '13 11 46', '10': '26 05 00', '11': '22 51 19', '12': '13 11 00',
  '13': '01 79 00', '14': '32 13 13', '15': '32 14 00', '16': '10 30 00', '17': '11 40 00', '18': '13 12 00',
};

/** "033713", "03-37-13", "03.37.13" → "03 37 13". Anything else is returned trimmed. */
function normalizeCode(code) {
  const s = String(code ?? '').trim();
  const m = /^(\d{2})[\s.-]?(\d{2})[\s.-]?(\d{2})$/.exec(s);
  return m ? `${m[1]} ${m[2]} ${m[3]}` : s;
}

/** Division number + name for a cost code ("03 37 13" → { division: '03', name: 'Concrete' }). */
function divisionOf(code) {
  const m = /^(\d{2})/.exec(String(code ?? ''));
  if (!m) return { division: '—', name: 'Other / Uncoded' };
  return { division: m[1], name: DIVISIONS[m[1]] || `Division ${m[1]}` };
}

module.exports = { DIVISIONS, COST_CODES, LEGACY_DIVISIONS, normalizeCode, divisionOf };
