// Safe formula evaluator for assembly quantity formulas (Pro-Est style).
// No eval / Function — a small tokenizer + recursive-descent parser.
//
// Supported:
//   numbers, variables (MC_POOL_WATER_SF ...), + - * / ^, parentheses, unary -
//   comparisons  = == <> != < <= > >=   (result 1 or 0)
//   functions    IF(c,a,b) AND(..) OR(..) NOT(x) ROUNDUP(x,d) ROUNDDOWN(x,d) ROUND(x,d)
//                CEILING(x[,sig]) FLOOR(x[,sig]) MIN(..) MAX(..) ABS(x)
// Function and variable names are case-insensitive.

class FormulaError extends Error {}

const FUNCS = {
  IF: (c, a, b = 0) => (truthy(c) ? a : b),
  AND: (...a) => (a.every(truthy) ? 1 : 0),
  OR: (...a) => (a.some(truthy) ? 1 : 0),
  NOT: (x) => (truthy(x) ? 0 : 1),
  ROUNDUP: (x, d = 0) => roundAway(x, d, Math.ceil),
  ROUNDDOWN: (x, d = 0) => roundAway(x, d, Math.floor),
  ROUND: (x, d = 0) => { const f = 10 ** d; return Math.round((x + Number.EPSILON) * f) / f; },
  CEILING: (x, s = 1) => (s === 0 ? 0 : Math.ceil(x / s - 1e-12) * s),
  FLOOR: (x, s = 1) => (s === 0 ? 0 : Math.floor(x / s + 1e-12) * s),
  MIN: (...a) => Math.min(...a),
  MAX: (...a) => Math.max(...a),
  ABS: (x) => Math.abs(x),
};

function truthy(v) { return v !== 0 && !Number.isNaN(v); }

// Excel-style ROUNDUP/ROUNDDOWN: away from / toward zero.
function roundAway(x, d, fn) {
  const f = 10 ** d;
  const v = Math.abs(x) * f;
  const r = fn === Math.ceil ? Math.ceil(v - 1e-9) : Math.floor(v + 1e-9);
  return (Math.sign(x) * r) / f;
}

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
      if (!m) throw new FormulaError(`Bad number at ${i + 1}`);
      toks.push({ t: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      toks.push({ t: 'id', v: m[0].toUpperCase() }); i += m[0].length; continue;
    }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '<>', '!=', '=='].includes(two)) { toks.push({ t: 'op', v: two === '!=' ? '<>' : two === '==' ? '=' : two }); i += 2; continue; }
    if ('+-*/^(),<>='.includes(ch)) { toks.push({ t: 'op', v: ch }); i++; continue; }
    throw new FormulaError(`Unexpected character "${ch}" at ${i + 1}`);
  }
  return toks;
}

// Grammar (lowest → highest precedence):
//   cmp  := add (( = <> < <= > >= ) add)*
//   add  := mul ((+|-) mul)*
//   mul  := unary ((*|/) unary)*
//   unary:= - unary | pow
//   pow  := atom (^ unary)?
//   atom := num | id | id '(' args ')' | '(' cmp ')'
function parse(src) {
  const toks = tokenize(String(src ?? ''));
  if (!toks.length) throw new FormulaError('Formula is empty');
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v) => peek() && peek().t === 'op' && peek().v === v;
  const expect = (v) => { if (!isOp(v)) throw new FormulaError(`Expected "${v}"`); p++; };

  function cmp() {
    let n = add();
    while (peek() && peek().t === 'op' && ['=', '<>', '<', '<=', '>', '>='].includes(peek().v)) {
      const op = toks[p++].v; n = { k: 'bin', op, a: n, b: add() };
    }
    return n;
  }
  function add() {
    let n = mul();
    while (isOp('+') || isOp('-')) { const op = toks[p++].v; n = { k: 'bin', op, a: n, b: mul() }; }
    return n;
  }
  function mul() {
    let n = unary();
    while (isOp('*') || isOp('/')) { const op = toks[p++].v; n = { k: 'bin', op, a: n, b: unary() }; }
    return n;
  }
  function unary() {
    if (isOp('-')) { p++; return { k: 'neg', a: unary() }; }
    if (isOp('+')) { p++; return unary(); }
    return pow();
  }
  function pow() {
    const n = atom();
    if (isOp('^')) { p++; return { k: 'bin', op: '^', a: n, b: unary() }; }
    return n;
  }
  function atom() {
    const t = peek();
    if (!t) throw new FormulaError('Unexpected end of formula');
    if (t.t === 'num') { p++; return { k: 'num', v: t.v }; }
    if (t.t === 'id') {
      p++;
      if (isOp('(')) {
        if (!FUNCS[t.v]) throw new FormulaError(`Unknown function ${t.v}`);
        p++;
        const args = [];
        if (!isOp(')')) { args.push(cmp()); while (isOp(',')) { p++; args.push(cmp()); } }
        expect(')');
        return { k: 'call', f: t.v, args };
      }
      return { k: 'var', v: t.v };
    }
    if (isOp('(')) { p++; const n = cmp(); expect(')'); return n; }
    throw new FormulaError(`Unexpected "${t.v}"`);
  }

  const ast = cmp();
  if (p < toks.length) throw new FormulaError(`Unexpected "${toks[p].v}"`);
  return ast;
}

function run(n, vars, missing) {
  switch (n.k) {
    case 'num': return n.v;
    case 'var': {
      if (Object.prototype.hasOwnProperty.call(vars, n.v)) return Number(vars[n.v]) || 0;
      missing.add(n.v); return 0;
    }
    case 'neg': return -run(n.a, vars, missing);
    case 'call': return FUNCS[n.f](...n.args.map((a) => run(a, vars, missing)));
    case 'bin': {
      const a = run(n.a, vars, missing), b = run(n.b, vars, missing);
      switch (n.op) {
        case '+': return a + b; case '-': return a - b; case '*': return a * b;
        case '/': return b === 0 ? 0 : a / b; // divide-by-zero → 0 so empty inputs don't blow up an estimate
        case '^': return a ** b;
        case '=': return Math.abs(a - b) < 1e-9 ? 1 : 0; case '<>': return Math.abs(a - b) >= 1e-9 ? 1 : 0;
        case '<': return a < b ? 1 : 0; case '<=': return a <= b ? 1 : 0;
        case '>': return a > b ? 1 : 0; case '>=': return a >= b ? 1 : 0;
      }
    }
  }
  throw new FormulaError('Invalid expression');
}

const cache = new Map();
function compile(src) {
  const key = String(src);
  if (!cache.has(key)) { if (cache.size > 5000) cache.clear(); cache.set(key, parse(key)); }
  return cache.get(key);
}

/** Evaluate a formula. vars: { NAME: number } (keys uppercase). */
function evaluate(src, vars = {}) {
  const missing = new Set();
  try {
    const value = run(compile(src), vars, missing);
    return { value: Number.isFinite(value) ? value : 0, missing: [...missing], error: null };
  } catch (e) {
    if (e instanceof FormulaError) return { value: 0, missing: [], error: e.message };
    throw e;
  }
}

/** Variable names referenced by a formula. */
function variablesIn(src) {
  const out = new Set();
  (function walk(n) {
    if (!n) return;
    if (n.k === 'var') out.add(n.v);
    if (n.a) walk(n.a); if (n.b) walk(n.b); if (n.args) n.args.forEach(walk);
  })(compile(src));
  return [...out];
}

function validate(src) {
  try { compile(src); return null; } catch (e) { return e.message; }
}

module.exports = { evaluate, variablesIn, validate, FUNCTIONS: Object.keys(FUNCS) };
