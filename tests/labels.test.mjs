// Labels: the table, its refusals, the lookup, and the hook that attaches a label to a
// Grep or Read result. Temporary folders only.
// node --test tests/labels.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tool = path.join(here, '..', 'tools', 'labels.mjs');
const hook = path.join(here, '..', 'hooks', 'atlas-labels.js');
const L = await import(pathToFileURL(tool).href);
// A private home for the run: a project's vault counts only when ~/.claude/atlas.json confirms it,
// so each test that writes one also confirms it here, and the real home is never read.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-home-'));
process.env.HOME = HOME; process.env.USERPROFILE = HOME; delete process.env.CLAUDE_CONFIG_DIR;
const userFile = path.join(HOME, '.claude', 'atlas.json');
const confirmVault = (v) => {
  fs.mkdirSync(path.dirname(userFile), { recursive: true });
  const c = fs.existsSync(userFile) ? JSON.parse(fs.readFileSync(userFile, 'utf8')) : {};
  c.vaults = [...(c.vaults || []), path.resolve(v)];
  fs.writeFileSync(userFile, JSON.stringify(c));
};

const vault = () => fs.mkdtempSync(path.join(os.tmpdir(), 'labels-'));

test('set, list, replace, unset', () => {
  const v = vault();
  assert.match(L.set(v, 'calcola_spread', 'SUPERSEDED', { to: 'spread_with_fees', why: 'ignored transaction costs', project: 'LAB' }), /^labelled {2}calcola_spread \(LAB\) is SUPERSEDED since \d{4}-\d\d-\d\d: use spread_with_fees instead\. Why: ignored transaction costs$/);
  assert.match(L.set(v, 'spread_with_fees', 'canonical', { why: 'the one the others copy' }), /^labelled {2}spread_with_fees is CANONICAL/);
  assert.match(L.set(v, 'calcola_spread', 'WRONG', { why: 'changed my mind' }), /^replaced/);
  assert.equal(L.list(v).length, 2);
  assert.equal(L.list(v)[0].label, 'CANONICAL', 'sorted by label');
  assert.match(L.unset(v, 'calcola_spread'), /^removed {3}1/);
  assert.match(L.unset(v, 'calcola_spread'), /^nothing/);
  assert.ok(fs.existsSync(path.join(v, '.atlas', 'labels.json')));
});

test('refusals: unknown label, no reason, SUPERSEDED without successor, not a symbol', () => {
  const v = vault();
  assert.throws(() => L.set(v, 'f', 'OLD', { why: 'x' }), /not a label/);
  assert.throws(() => L.set(v, 'f', 'WRONG', {}), /--why is required/);
  assert.throws(() => L.set(v, 'f', 'SUPERSEDED', { why: 'x' }), /needs --to/);
  assert.throws(() => L.set(v, 'not a name', 'WRONG', { why: 'x' }), /not a symbol name/);
  assert.equal(L.list(v).length, 0, 'nothing written');
});

test('lookup matches whole words only, each symbol once', () => {
  const v = vault();
  L.set(v, 'spread', 'SUPERSEDED', { to: 'spread_with_fees', why: 'costs' });
  L.set(v, 'atr', 'FRAGILE', { why: 'needs 14 bars' });
  const hits = L.lookup(v, 'x = spread(a)\ny = spread_with_fees(b)\nz = atr(c) + atr(d)');
  assert.deepEqual(hits.map((h) => h.symbol), ['spread', 'atr']);
  assert.equal(L.lookup(v, 'myspread = 1').length, 0, 'part of a longer word is not the symbol');
});

test('the hook attaches labels to a Grep result and stays silent otherwise', () => {
  const v = vault();
  L.set(v, 'calcola_spread', 'SUPERSEDED', { to: 'spread_with_fees', why: 'ignored costs', file: 'engine/old.py' });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  fs.writeFileSync(path.join(cwd, '.atlas.json'), JSON.stringify({ vault: v }));
  confirmVault(v);
  const run = (input) => spawnSync(process.execPath, [hook], { input: JSON.stringify(input), encoding: 'utf8' });
  const grep = run({ hook_event_name: 'PostToolUse', tool_name: 'Grep', cwd, tool_input: { pattern: 'spread' }, tool_response: { content: 'engine/old.py:41:def calcola_spread(x):' } });
  assert.equal(grep.status, 0);
  const out = JSON.parse(grep.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /calcola_spread \(engine\/old\.py\) is SUPERSEDED since \d{4}-\d\d-\d\d: use spread_with_fees instead\. Why: ignored costs/);
  const clean = run({ hook_event_name: 'PostToolUse', tool_name: 'Grep', cwd, tool_input: { pattern: 'x' }, tool_response: 'nothing here' });
  assert.equal(clean.stdout, '', 'no labelled symbol: no output');
  const other = run({ hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd, tool_response: 'calcola_spread' });
  assert.equal(other.stdout, '', 'other tools are not looked at');
  const noVault = run({ hook_event_name: 'PostToolUse', tool_name: 'Read', cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'nov-')), tool_response: 'calcola_spread' });
  assert.equal(noVault.stdout, '', 'no vault for the directory: silent');
});

test('vault resolution: .atlas.json above the directory, then the memory folder of the path', () => {
  const v = vault();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-'));
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(root, '.atlas.json'), JSON.stringify({ vault: v }));
  confirmVault(v);
  assert.equal(L.vaultFor(path.join(root, 'a', 'b')), path.resolve(v));
  assert.equal(L.vaultFor(fs.mkdtempSync(path.join(os.tmpdir(), 'none-'))), null);
});

test('a project vault nobody confirmed is not used, by the tool or by the hook', () => {
  // a cloned repository must not choose where the hooks read labels or write session lines
  const v = vault();
  L.set(v, 'calcola_spread', 'WRONG', { why: 'planted' });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'untrusted-'));
  fs.writeFileSync(path.join(cwd, '.atlas.json'), JSON.stringify({ vault: v }));
  assert.equal(L.vaultFor(cwd), null);
  assert.equal(L.pendingVault(cwd), path.resolve(v));
  assert.match(L.main(['vault', cwd]), /not confirmed: add it to "vaults"/);
  const r = spawnSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Grep', cwd, tool_response: 'calcola_spread' }), encoding: 'utf8' });
  assert.equal(r.stdout, '', 'unconfirmed vault: the hook is silent');
  confirmVault(v);
  assert.equal(L.vaultFor(cwd), path.resolve(v));
  assert.equal(L.pendingVault(cwd), null);
});

test('the vault of the user file is confirmed and is the fallback', () => {
  const mine = vault();
  const before = fs.existsSync(userFile) ? fs.readFileSync(userFile, 'utf8') : null;
  fs.mkdirSync(path.dirname(userFile), { recursive: true });
  fs.writeFileSync(userFile, JSON.stringify({ vault: mine }));
  try {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-'));
    assert.equal(L.vaultFor(plain), path.resolve(mine), 'no project file: the user vault');
    const named = fs.mkdtempSync(path.join(os.tmpdir(), 'named-'));
    fs.writeFileSync(path.join(named, '.atlas.json'), JSON.stringify({ vault: mine }));
    assert.equal(L.vaultFor(named), path.resolve(mine), 'a project naming the user vault needs nothing more');
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'other-'));
    fs.writeFileSync(path.join(other, '.atlas.json'), JSON.stringify({ vault: vault() }));
    assert.equal(L.vaultFor(other), path.resolve(mine), 'an unconfirmed project vault falls back to the user vault');
  } finally {
    if (before === null) fs.rmSync(userFile, { force: true }); else fs.writeFileSync(userFile, before);
  }
});

// A vault whose notes are linked to files of a repository, the way `memcheck link` writes them.
function linkedVault(notes) {
  const v = vault();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-repo-'));
  const norm = (p) => { const a = path.resolve(p).replace(/\\/g, '/'); return process.platform === 'win32' ? a.toLowerCase() : a; };
  const side = { version: 1, notes: {} };
  for (const [slug, { file, trust = 'firm', dep }] of Object.entries(notes)) {
    fs.writeFileSync(path.join(v, `${slug}.md`), `---\nname: ${slug}\ndescription: Why ${slug} holds\n---\n\nbody\n`);
    const link = { repo: norm(repo), file, lines: '1-3', symbol: 'f', fingerprint: 'x' };
    if (dep) link.deps = [{ file: dep, symbol: 'g', lines: '1-2' }];
    side.notes[slug] = { links: [link], trust };
  }
  fs.mkdirSync(path.join(v, '.atlas'), { recursive: true });
  fs.writeFileSync(path.join(v, '.atlas', 'links.json'), JSON.stringify(side));
  fs.writeFileSync(path.join(repo, '.atlas.json'), JSON.stringify({ vault: v }));
  confirmVault(v);
  return { v, repo };
}
const readHook = (repo, file, session) => {
  const r = spawnSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Read', cwd: repo, session_id: session, tool_input: { file_path: path.join(repo, file) }, tool_response: { file: { content: 'nothing labelled' } } }), encoding: 'utf8', env: { ...process.env, HOME, USERPROFILE: HOME } });
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '';
};

test('a Read of a linked file brings its notes once a session, and nothing for other files', () => {
  const { repo } = linkedVault({ 'pay-limit': { file: 'src/pay.js' }, 'pay-retry': { file: 'src/pay.js', trust: 'suspect' }, 'uses-pay': { file: 'src/ui.js', dep: 'src/pay.js' } });
  const session = 'labels-test-' + Math.random().toString(36).slice(2);
  const first = readHook(repo, 'src/pay.js', session);
  const lines = first.split('\n');
  assert.match(lines[0], /^ATLAS notes linked to this file/);
  assert.equal(lines[1], '- pay-retry (SUSPECT: its code has changed): Why pay-retry holds', 'a suspect note comes first');
  assert.equal(lines[2], '- pay-limit (firm): Why pay-limit holds');
  assert.equal(lines[3], '- uses-pay (firm, through code it depends on): Why uses-pay holds');
  assert.equal(readHook(repo, 'src/pay.js', session), '', 'the same file again in the session: silent');
  assert.equal(readHook(repo, 'src/other.js', session), '', 'no note linked: silent');
  assert.match(readHook(repo, 'src/pay.js', 'labels-test-other-' + Math.random().toString(36).slice(2)), /pay-retry/, 'a new session sees it again');
});

test('a link written by memcheck is found from the path a Read hands the hook', () => {
  const { v, repo } = linkedVault({});
  fs.writeFileSync(path.join(v, 'limit.md'), '---\nname: limit\ndescription: The retry limit is 3\n---\n\nbody\n');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'pay.js'), 'function retryPayment(n) {\n  return n < 3;\n}\n');
  const made = spawnSync(process.execPath, [path.join(here, '..', 'tools', 'memcheck.mjs'), 'link', v, 'limit', repo, 'src/pay.js', 'retryPayment'], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  assert.match(readHook(repo, 'src/pay.js', 'labels-test-' + Math.random().toString(36).slice(2)), /- limit \((firm|unverified)\): The retry limit is 3/);
});

test('at most three notes per file, the rest counted', () => {
  const { repo } = linkedVault(Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((s) => [`note-${s}`, { file: 'core.py' }])));
  const text = readHook(repo, 'core.py', 'labels-test-' + Math.random().toString(36).slice(2));
  assert.equal(text.split('\n').filter((l) => l.startsWith('- ')).length, 3);
  assert.match(text, /and 2 more: memcheck impact on this file$/);
});

test('the file lookup stays under 50 ms on 316 linked notes', () => {
  const { notesFor } = createRequire(import.meta.url)(hook);
  const side = { notes: {} };
  for (let i = 0; i < 316; i += 1) side.notes[`n${i}`] = { trust: 'firm', links: [{ repo: '/r', file: `src/f${i}.js`, deps: [{ file: `src/d${i}.js` }] }] };
  const t = process.hrtime.bigint();
  const hits = notesFor(side, '/r/src/f7.js');
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  assert.deepEqual(hits.map((h) => h.slug), ['n7']);
  assert.ok(ms < 50, `${ms} ms`);
});

test('the hook file stays under the 10 KB ceiling', () => {
  assert.ok(fs.statSync(hook).size < 10 * 1024, `${fs.statSync(hook).size} bytes`);
});
