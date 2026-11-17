// Exact decimal money arithmetic. Amounts are integer cents; quantities, prices and
// percentages are scaled to integers and multiplied as BigInt, then rounded once
// (half away from zero). Never sums floating-point dollars.

const Q = 1_000_000; // quantities and prices are carried to 6 decimals
const P = 100_000_000; // percentages (fractions) to 8 decimals

const big = (x, scale) => BigInt(Math.round(Number(x || 0) * scale));

/** a / b rounded half away from zero (BigInt, b > 0). */
function roundDiv(a, b) {
  const q = a / b, r = a % b;
  if (2n * (r < 0n ? -r : r) >= b) return q + (a < 0n ? -1n : 1n);
  return q;
}
/** floor(a / b) for BigInt, b > 0. */
function floorDiv(a, b) {
  const q = a / b;
  return a % b !== 0n && a < 0n ? q - 1n : q;
}

/** Dollars → integer cents. */
const cents = (dollars) => Number(roundDiv(big(dollars, Q), 10_000n));
/** Integer cents → dollars (a float that prints exactly to 2 decimals). */
const dollars = (c) => c / 100;
/** qty × unit price (dollars) → cents. */
const ext = (qty, unitPrice) => Number(roundDiv(big(qty, Q) * big(unitPrice, Q), 10_000_000_000n));
/** qty × unit price already in cents → cents. */
const extCents = (qty, unitCents) => Number(roundDiv(big(qty, Q) * BigInt(unitCents), BigInt(Q)));
/** cents × fraction (0.0825 = 8.25%) → cents. */
const pct = (baseCents, fraction) => Number(roundDiv(BigInt(baseCents) * big(fraction, P), BigInt(P)));

/**
 * Split `total` cents across rows in proportion to integer `weights`, so the parts
 * add up to `total` exactly (largest-remainder method).
 */
function allocate(total, weights) {
  const n = weights.length;
  const out = new Array(n).fill(0);
  if (!n || total === 0) return out;
  let W = weights.reduce((s, w) => s + BigInt(w), 0n);
  if (W === 0n) { out[0] = total; return out; }
  const sign = W < 0n ? -1n : 1n; W *= sign;
  const T = BigInt(total);
  const rems = [];
  let used = 0n;
  weights.forEach((w, i) => {
    const num = T * BigInt(w) * sign;
    const share = floorDiv(num, W);
    out[i] = Number(share); used += share;
    rems.push([num - share * W, i]);
  });
  let left = Number(T - used);
  rems.sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] > b[0] ? -1 : 1));
  for (let k = 0; left > 0; k++, left--) out[rems[k % n][1]] += 1;
  return out;
}

const TYPES = ['L', 'M', 'E', 'S', 'O']; // Labor, Material, Equipment, Subcontractor, Other

/** Markup chain on cost-type buckets (cents). Returns cents. */
function markupChain(buckets, markups) {
  const direct = TYPES.reduce((s, t) => s + (buckets[t] || 0), 0);
  let running = direct;
  const amounts = markups.map((m) => {
    const base = TYPES.includes(m.basis) ? buckets[m.basis] || 0 : m.basis === 'direct' ? direct : running;
    const amount = pct(base, m.percent);
    running += amount;
    return { id: m.id, name: m.name, percent: m.percent, basis: m.basis, amount, base };
  });
  return { direct, markups: amounts, total: running };
}

module.exports = { cents, dollars, ext, extCents, pct, allocate, markupChain, TYPES };
