// Pending commitments: the secret behind a paid commit lives only in this browser, so the code
// that stores, shows and deletes it must never act on another account's — and must keep
// tracking the one commitment it is about across every await.
//
// Functions are lifted out of index.html by name and run in a vm sandbox with a localStorage
// and DOM shim. No network, no chain.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, 'index.html'), 'utf8').split('\n');

function lift(name) {
  const re = new RegExp(`^(async )?function ${name}\\s*\\(`);
  const start = SRC.findIndex(l => re.test(l));
  if (start < 0) throw new Error(`index.html no longer defines ${name}()`);
  let depth = 0;
  const out = [];
  for (let i = start; i < SRC.length; i++) {
    out.push(SRC[i]);
    for (const ch of SRC[i]) { if (ch === '{') depth++; else if (ch === '}') depth--; }
    if (depth === 0 && out.join('').includes('{')) return out.join('\n');
  }
  throw new Error(`unterminated ${name}()`);
}

let pass = 0, fail = 0;
const ok = (name, cond, detail) => cond
  ? (pass++, console.log('ok    ' + name))
  : (fail++, console.log('FAIL  ' + name + (detail ? '\n        ' + detail : '')));
const eq = (name, got, want) => ok(name, got === want, `got  ${got}\n        want ${want}`);

const A = '0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa';
const B = '0xBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbb';
const S = (c) => '0x' + c.repeat(64);
const rec = (name, owner, secret, extra = {}) => ({ name, owner, secret, timestamp: 1_700_000_000, confirmed: true, ...extra });

function sandbox({ connected = null } = {}) {
  const store = new Map();
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
    key: i => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) {
      const cls = new Set();
      els.set(id, { id, value: '', textContent: '', innerHTML: '', disabled: false, style: {},
        classList: { add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c),
                     toggle: (c, on) => (on ?? !cls.has(c)) ? cls.add(c) : cls.delete(c) },
        remove() {}, scrollIntoView() {}, parentNode: { insertBefore() {} } });
    }
    return els.get(id);
  };
  const calls = { check: 0, reveal: 0, status: [] };
  const ctx = vm.createContext({
    console, JSON, Number, String, Math, Date, Promise, Object, Array, BigInt, Error,
    localStorage, setTimeout: () => 0, clearTimeout: () => {},
    $: el, document: { getElementById: el },
    _connectedAddress: connected, contract: {}, _signer: connected ? {} : null,
    STORAGE_KEY: 'wei_pending_commits', MIN_COMMIT_AGE: 60, MAX_COMMIT_AGE: 86400, CLOCK_MARGIN: 3,
    WEI_TERMS: '0x0000002ba1dd65dBe75388F6672826FaC6Ec69fe', ZROUTER: '0x000000000000FB114709235f1ccBFfb925F600e4',
    doCheckName: () => { calls.check++; }, doRevealSelected: () => { calls.reveal++; },
    showStatus: (m, t) => calls.status.push([t, m]), decodeTacitAddress: v => v,
    lockTacitOpt: () => {}, paintTacitOpt: () => {}, readPendingTerms: () => 1, pendingPriceHtml: () => '',
    spinnerSVG: () => '', escapeHtml: s => String(s), selectedPayMethod: 'eth', isRevealing: false,
    withRpc: async () => { throw new Error('no rpc in tests'); }, localComputeId: () => 1n,
    ethers: { Contract: class {}, ZeroAddress: '0x' + '00'.repeat(20) },
  });
  vm.runInContext([
    "const PENDING_PREFIX = 'wei_pending:';", 'let pendingCache = null;',
    'const HASH32_RE = /^0x[0-9a-fA-F]{64}$/;', 'let pendingTimerId = 0, pendingTimeoutId = null;',
    'let _revealArmed = false, _revealNotBefore = 0;',
    ...['pendingKeyFor', 'savePending', 'sanePending', 'loadPending', 'hidePendingPanel',
        'clearPending', 'initPending', 'displayPending', 'updateTimer'].map(lift),
    'this.set = (k, v) => { eval(k + " = v"); }; this.get = (k) => eval(k);',
  ].join('\n'), ctx, { filename: 'index.html:pending' });
  const put = (r) => store.set('wei_pending:' + r.owner.toLowerCase(), JSON.stringify(r));
  return { ctx, store, put, calls, el, run: (c) => vm.runInContext(c, ctx) };
}

// ── clearPending deletes only the commitment it was asked about ──────────────
{
  const s = sandbox({ connected: B });
  const a = rec('alice', A, S('a')), b = rec('bob', B, S('b'));
  s.put(a); s.put(b);
  s.el('pending').classList.add('show');
  s.ctx.__a = a;
  s.run('clearPending(__a)');
  eq('clear(A) while B is connected removes A', s.store.has('wei_pending:' + A.toLowerCase()), false);
  eq('… and leaves B\'s secret alone', s.store.has('wei_pending:' + B.toLowerCase()), true);
  eq('… and leaves B\'s panel showing', s.el('pending').classList.contains('show'), true);
  eq('… and does not re-run the lookup', s.calls.check, 0);
}
{
  const s = sandbox({ connected: A });
  const older = rec('alice', A, S('1')), newer = rec('alice', A, S('2'));
  s.put(newer);
  s.ctx.__old = older;
  s.run('clearPending(__old)');
  eq('a newer commitment in the same slot survives clearing the old one', JSON.parse(s.store.get('wei_pending:' + A.toLowerCase())).secret, S('2'));
}
{
  const s = sandbox({ connected: B });
  s.put(rec('bob', B, S('b')));
  s.el('pending').classList.add('show');
  s.run('clearPending()');
  eq('Cancel (no target) removes the one on screen', s.store.has('wei_pending:' + B.toLowerCase()), false);
  eq('… and closes the panel', s.el('pending').classList.contains('show'), false);
}

// ── initPending paints only what is still this account's commitment ─────────
{
  const s = sandbox({ connected: null });
  s.put(rec('alice', A, S('a')));
  // The availability read resolves only after the account has changed to B, who has none.
  s.ctx.withRpc = async () => { s.ctx._connectedAddress = B; s.run('pendingCache = null'); return true; };
  await s.run('initPending()');
  eq('a commitment that stopped being current mid-read is not painted', s.el('pending').classList.contains('show'), false);
}
{
  const s = sandbox({ connected: A });
  s.put(rec('alice', A, S('a')));
  s.ctx.withRpc = async () => true;
  await s.run('initPending()');
  eq('the current account\'s commitment is painted', s.el('pending').classList.contains('show'), true);
}

// ── loadPending keeps one object per commitment while disconnected ──────────
{
  const s = sandbox({ connected: null });
  s.put(rec('alice', A, S('a')));
  const first = s.run('loadPending()');
  first._revealPolls = 7;
  eq('disconnected: the same object comes back', s.run('loadPending()') === first, true);
  eq('… so its poll counter survives the next tick', s.run('loadPending()._revealPolls'), 7);
  s.put(rec('alice2', A, S('c'), { timestamp: 1_800_000_000 }));
  eq('a different commitment in storage is a different object', s.run('loadPending().secret'), S('c'));
}

// ── a queued reveal fires only for the commitment it was queued for ────────
{
  const now = Math.floor(Date.now() / 1000);
  const s = sandbox({ connected: B });
  s.put(rec('bob', B, S('b'), { timestamp: now - 120 }));   // past the minute: ready
  s.run(`_revealArmed = ${JSON.stringify(S('a'))}`);          // queued while A was connected
  s.run('pendingTimerId = 1');
  await s.run('updateTimer(1)');
  eq('queued for A, B\'s timer does not register anything', s.calls.reveal, 0);
  s.run(`_revealArmed = ${JSON.stringify(S('b'))}`);
  await s.run('updateTimer(1)');
  eq('queued for B, B\'s timer registers it', s.calls.reveal, 1);
}

// ── the countdown and the reveal check agree on when the minute is up ───────
{
  const s = sandbox({ connected: A });
  // updateTimer's markCommitConfirmed and doCommit both take the block time + CLOCK_MARGIN.
  const src = SRC.join('\n');
  ok('countdown starts at block time + CLOCK_MARGIN, uncapped', /pending\.timestamp = ts \? Number\(ts\) \+ CLOCK_MARGIN/.test(src)
     && /ts = Number\(blk\.timestamp\) \+ CLOCK_MARGIN/.test(src) && !/Math\.min\(ts, Number\(blk\.timestamp\)/.test(src));
  ok('revealPreflight measures from the same point', /chainTs \? chainTs \+ CLOCK_MARGIN/.test(src));
  void s;
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
