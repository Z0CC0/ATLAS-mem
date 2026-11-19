// The memory with nobody remembering it: the recall hook, the session-start hook, the claims about
// notes with no code link, and the links made by themselves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const recall = path.join(here, '..', 'hooks', 'atlas-recall.js');
const fresh = path.join(here, '..', 'hooks', 'atlas-fresh.js');
const tool = path.join(here, '..', 'tools', 'memcheck.mjs');
const { rank, readNotes } = createRequire(import.meta.url)(recall);
const { say, reused, cacheFile, MAX_NOTES, REUSE_MS } = createRequire(import.meta.url)(fresh);
const claims = await import(pathToFileURL(path.join(here, '..', 'tools', 'claims.mjs')).href);

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const note = (name, description, body = '') => `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: project\n---\n\n${body}\n`;

function vault(notes) {
  const v = tmp('atlas-vault-');
  for (const [slug, text] of Object.entries(notes)) fs.writeFileSync(path.join(v, `${slug}.md`), text);
  return v;
}

function home(config) {
  const h = tmp('atlas-rhome-');
  fs.mkdirSync(path.join(h, '.claude'), { recursive: true });
  if (config) fs.writeFileSync(path.join(h, '.claude', 'atlas.json'), JSON.stringify(config));
  const env = { ...process.env, HOME: h, USERPROFILE: h };
  delete env.CLAUDE_CONFIG_DIR;
  return env;
}

const FILLER = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`other-${i}`, note(`Other ${i}`, `Something unrelated number ${i}, about gardening and bicycles`, 'Nothing here about money. Common project words: progetto, utente.')]));

test('a prompt finds the note it is about, and a rare word outweighs a common one', () => {
  const v = vault({ ...FILLER, 'pagamenti-retry': note('Retry dei pagamenti', 'Il limite di tentativi sui pagamenti e 3 perche la banca blocca a 5') });
  const found = rank('quanti tentativi facciamo sui pagamenti della banca?', readNotes(v));
  assert.equal(found[0].note.slug, 'pagamenti-retry');
});

test('words every note has do not reach the bar', () => {
  const v = vault(FILLER);
  assert.deepEqual(rank('il progetto per l utente something unrelated', readNotes(v)).filter((r) => r.score > 100), []);
  assert.deepEqual(rank('come cucino la pasta alla carbonara stasera?', readNotes(v)), []);
});

test('a private part is never read', () => {
  const v = vault({ ...FILLER, segreto: note('Segreto', 'Una nota qualunque', '<private>carbonara segretissima</private>') });
  const n = readNotes(v).find((x) => x.slug === 'segreto');
  assert.ok(![...n.body].some((w) => w.startsWith('carbo')));
});

function fire(v, env, prompt, session = 'recall-test-' + Math.random().toString(36).slice(2)) {
  fs.writeFileSync(path.join(env.HOME, '.claude', 'atlas.json'), JSON.stringify({ ...JSON.parse(fs.existsSync(path.join(env.HOME, '.claude', 'atlas.json')) ? fs.readFileSync(path.join(env.HOME, '.claude', 'atlas.json'), 'utf8') : '{}'), vault: v }));
  const r = spawnSync(process.execPath, [recall], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, cwd: env.HOME, session_id: session }), encoding: 'utf8', env });
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '';
}

test('the hook brings a note once a session, and stays quiet on a short prompt or when switched off', () => {
  const v = vault({ ...FILLER, 'pagamenti-retry': note('Retry dei pagamenti', 'Il limite di tentativi sui pagamenti e 3 perche la banca blocca a 5') });
  const env = home();
  const session = 'recall-test-' + Math.random().toString(36).slice(2);
  const first = fire(v, env, 'quanti tentativi facciamo sui pagamenti della banca?', session);
  assert.match(first, /pagamenti-retry/);
  assert.match(first, /check it against the code/);
  assert.equal(fire(v, env, 'quanti tentativi facciamo sui pagamenti della banca?', session), '');
  assert.equal(fire(v, env, 'ok grazie'), '');
  assert.equal(fire(v, env, '/atlas-help pagamenti banca tentativi'), '');
  const off = home({ recall: false });
  assert.equal(fire(v, off, 'quanti tentativi facciamo sui pagamenti della banca?'), '');
});

test('paths in a note are read as written, and placeholders and commands are not paths', () => {
  const found = claims.pathsIn('sta in `src/x/y.ts` e in C:\\Users\\a\\b.txt, non in `<vault>/x` ne in `a b/c` ne `https://x.y/z` ne `.atlas/links.json`');
  assert.ok(found.includes('src/x/y.ts'));
  assert.ok(found.some((p) => p.startsWith('C:\\Users\\a\\b.txt')));
  assert.ok(!found.some((p) => p.includes('<vault>') || p.startsWith('http') || p.includes('a b') || p.startsWith('.atlas')));
});

test('a path that is gone is said; one that may belong elsewhere is not', () => {
  const root = tmp('atlas-root-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.js'), '');
  assert.equal(claims.judgePath('src/a.js', [root], root).state, 'there');
  assert.equal(claims.judgePath('src/gone.js', [root], root).state, 'gone');
  assert.equal(claims.judgePath('src/moved.js', [root], root, ['other/moved.js']).state, 'unknown');
  assert.equal(claims.judgePath('other/place.js', [root], root).state, 'unknown');
});

test('a rooted path may hold spaces, and only a missing folder makes it gone', () => {
  const home = tmp('atlas-home2-');
  fs.mkdirSync(path.join(home, 'Desktop', 'My Folder'), { recursive: true });
  assert.equal(claims.judgePath('Desktop\\My Folder and then some words', [], home).state, 'there');
  const j = claims.judgePath('Desktop\\Old Folder\\x', [], home);
  assert.equal(j.state, 'gone');
  assert.equal(j.strong, true);
});

test('a path the note itself says is gone is history, not a claim', () => {
  const text = 'La copia in `Desktop\\Old\\x` e il clone sono stati cestinati il 2026-10-09. Il lavoro sta in `Desktop\\Old\\y`; il resto altrove.';
  assert.equal(claims.toldGone(text, 'Desktop\\Old\\x'), true);
  assert.equal(claims.toldGone(text, 'Desktop\\Old\\y'), false);
  assert.equal(claims.toldGone('Moved from `a/b.js`, which was removed. Now in `a/b.js` again.', 'a/b.js'), false);
});

test('a history section says where things were, and is not checked', () => {
  const home = tmp('atlas-home4-');
  fs.mkdirSync(path.join(home, 'Desktop'));
  const seen = (body) => claims.checkNote('n', note('n', 'x', body), { home }).map((i) => i.grade);
  assert.deepEqual(seen('Ora sta altrove.\n\n## Storia\n\nStava in `Desktop\\Vecchia\\x`.\n'), []);
  assert.deepEqual(seen('Sta in `Desktop\\Vecchia\\x`.\n\n## Storia\n\nNiente.\n'), ['gone']);
  assert.deepEqual(seen('## Storia\n\nNiente.\n\n## Stato\n\nSta in `Desktop\\Vecchia\\x`.\n'), ['gone']);
});

test('a backslash read as an escape is said', () => {
  assert.equal(claims.brokenIn('sta in `Desktop\\ATLAS\u0007tlas-test`').length, 1);
  assert.equal(claims.brokenIn('script `strumenti\nigenera.ps1` qui').length, 1);
  assert.deepEqual(claims.brokenIn('sta in `Desktop\\ATLAS\\atlas-test`\nriga nuova `x`'), []);
});

test('a relative path is judged only against folders the note names', () => {
  const home = tmp('atlas-home3-');
  fs.mkdirSync(path.join(home, 'Desktop', 'App', 'src'), { recursive: true });
  fs.writeFileSync(path.join(home, 'Desktop', 'App', 'src', 'a.js'), '');
  const other = tmp('atlas-root-');
  fs.mkdirSync(path.join(other, 'src'));
  const seen = (body) => claims.checkNote('n', note('n', 'x', body), { roots: [other], home }).map((i) => i.grade);
  assert.deepEqual(seen('In `Desktop\\App`: `src/a.js`.'), []);
  assert.deepEqual(seen('In `Desktop\\App`: `src/b.js`.'), ['gone?']);
  assert.deepEqual(seen('Another project: `src/b.js`.'), []);
});

test('a version in the description that the project has left is said; a matching one is not', () => {
  const root = tmp('atlas-root-');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'ledger', version: '2.0.0' }));
  const v = vault({ vecchia: note('ledger', 'ledger 1.4.0 pubblicata'), giusta: note('ledger stato', 'ledger 2.0.0 pubblicata'), altra: note('altro', 'pippo 1.4.0') });
  const items = claims.checkVault(v, { roots: [root], home: root });
  assert.deepEqual(items.filter((i) => i.grade === 'version').map((i) => i.slug), ['vecchia']);
});

test('the session-start line is short, and says nothing when all is well', () => {
  assert.equal(say([]), null);
  const many = Array.from({ length: 8 }, (_, i) => ({ slug: `n${i}`, reason: 'x' }));
  assert.equal(say(many).split('\n').length, 1 + MAX_NOTES + 1);
});

test('a subagent gets the session stale notes, reused while recent and for the same vault only', () => {
  const v = vault(FILLER);
  const env = home({ vault: v });
  const session = 'fresh-test-' + Math.random().toString(36).slice(2);
  const items = [{ slug: 'old-limit', reason: 'retryPayment in pay.js changed since this note was written' }];
  fs.writeFileSync(cacheFile(session), JSON.stringify({ vault: path.resolve(v), at: Date.now(), items }));
  assert.deepEqual(reused(session, path.resolve(v)), items);
  assert.equal(reused(session, path.resolve(v), Date.now() + REUSE_MS + 1), null, 'too old: checked again');
  assert.equal(reused(session, path.resolve(tmp('atlas-vault-'))), null, 'another vault: checked again');
  const r = spawnSync(process.execPath, [fresh], { input: JSON.stringify({ hook_event_name: 'SubagentStart', agent_type: 'atlas-mem:atlas-finder', cwd: env.HOME, session_id: session }), encoding: 'utf8', env });
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'SubagentStart');
  assert.match(out.additionalContext, /- old-limit: retryPayment in pay\.js changed/);
  const off = home({ vault: v, fresh: false });
  assert.equal(spawnSync(process.execPath, [fresh], { input: JSON.stringify({ hook_event_name: 'SubagentStart', cwd: off.HOME, session_id: session }), encoding: 'utf8', env: off }).stdout, '');
});

test('autolink links a definition a note names, only when certain, and the check then watches it', () => {
  const repo = tmp('atlas-repo-');
  fs.writeFileSync(path.join(repo, 'pay.js'), 'function retryPayment(n) {\n  return n < 3;\n}\nmodule.exports = { retryPayment };\n');
  fs.writeFileSync(path.join(repo, 'a.js'), 'function twice() { return 1; }\n');
  fs.writeFileSync(path.join(repo, 'b.js'), 'function twice() { return 2; }\n');
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  git('init', '-q'); git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x');
  const v = vault({ limite: note('Limite', 'Il limite dei tentativi', 'Lo decide `retryPayment` in `pay.js`. Non confonderlo con `twice` o con `find`.') });
  const env = { ...process.env };
  const out = spawnSync(process.execPath, [tool, 'autolink', v, 'limite', '--root', repo], { encoding: 'utf8', env }).stdout;
  assert.match(out, /linked limite → pay\.js/);
  assert.match(out, /linked 1/);
  const side = JSON.parse(fs.readFileSync(path.join(v, '.atlas', 'links.json'), 'utf8'));
  assert.deepEqual(side.notes.limite.links.map((l) => l.symbol), ['retryPayment']);
  fs.writeFileSync(path.join(repo, 'pay.js'), 'function retryPayment(n) {\n  return n < 5;\n}\nmodule.exports = { retryPayment };\n');
  const seen = JSON.parse(spawnSync(process.execPath, [tool, 'fresh', v, '--root', repo, '--json'], { encoding: 'utf8', env }).stdout);
  assert.equal(seen[0].slug, 'limite');
  assert.equal(seen[0].grade, 'code');
});
