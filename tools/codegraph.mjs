#!/usr/bin/env node
/**
 * ATLAS memory — the code graph across projects.
 *
 * One root folder, one project per sub-folder. Every source file is parsed once
 * (tree-sitter, `parse.mjs`) and the graph records: the files and what they import, the
 * top-level symbols and which other symbol of the same project each one calls, the pieces
 * of code written twice (identical text, or the same shape under other names) inside a
 * project and across projects, and the symbols nothing calls. It reads and writes one JSON;
 * it never changes a source file.
 *
 *   node codegraph.mjs scan   <root> [--out <file.json>] [--skip a,b] [--porting "A|B,C|D"] [--quiet]
 *   node codegraph.mjs report <file.json>
 *   node codegraph.mjs dups   <file.json> [--project <name>] [--cross]
 *   node codegraph.mjs hubs   <file.json> [<project>]
 *   node codegraph.mjs dead   <file.json> [<project>]
 *   node codegraph.mjs impact <file.json> <project> <symbol> [--depth 2]
 *
 * Duplicates between two projects declared as a porting of one another are kept in the
 * data and marked, never counted: a port is the same code on purpose. Dead-code candidates
 * are graded (certain / probable / uncertain) from the false-positive list — dynamic
 * dispatch, IPC by string, FFI, entry points in configuration — and are only ever a label.
 *
 * A scan records what it was taken from: each project's commit and each file's size and mtime.
 * Every read command starts by saying how many files changed, went or arrived since, and `dead`
 * refuses to answer while any did. A reference whose name the project defines more than once is
 * kept as inferred, never counted, and `impact` lists it apart and ends with how many such
 * references touch the radius.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, extname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as parse from './parse.mjs';
import { listFiles, forget as forgetFiles, SKIP_DIRS } from './repo.mjs';

const VERSION = 1;
/** Folders no project wants scanned, beyond what `repo.mjs` already skips. */
const DEFAULT_SKIP = ['release', 'runtime', 'ritirati', '_materiale-studio', 'duplicati', 'wasm', 'public', 'static', 'assets'];
const MIN_DUP_LINES = 6;
const MIN_DUP_TOKENS = 40;

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
const normText = (lines) => lines.map((l) => l.trim()).filter(Boolean).join('\n');

// ---------------------------------------------------------------------------------------
// the scan

function readLines(path) {
  let text = readFileSync(path, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.split(/\r?\n/);
}

/** Resolve an import to a file of the same project, or null when it is a library. */
function resolveImport(mod, fromFile, files, grammar) {
  if (!mod) return null;
  const have = new Set(files);
  const tryAll = (cands) => cands.find((c) => have.has(c)) || null;
  if (grammar === 'python') {
    const dots = (mod.match(/^\.+/) || [''])[0].length;
    const rest = mod.slice(dots).split('.').filter(Boolean);
    const base = dots ? posix.dirname(fromFile) : '';
    let dir = base;
    for (let i = 1; i < dots; i += 1) dir = posix.dirname(dir);
    const rel = posix.join(dir, ...rest);
    return tryAll([`${rel}.py`, posix.join(rel, '__init__.py'), ...(dir === '' ? [] : [`${posix.join(...rest)}.py`, posix.join(...rest, '__init__.py')])]);
  }
  if (!mod.startsWith('.') && !mod.startsWith('/')) return null;
  const rel = posix.normalize(posix.join(posix.dirname(fromFile), mod));
  const exts = ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts'];
  const found = tryAll([...exts.map((e) => rel + e), ...exts.slice(1).map((e) => posix.join(rel, 'index' + e))]);
  if (found != null) return found;
  // TypeScript under NodeNext or a bundler imports `./x.js` and means `x.ts`
  const m = /^(.*)\.(js|mjs|cjs)$/.exec(rel);
  return m ? tryAll([`${m[1]}.ts`, `${m[1]}.tsx`, `${m[1]}.mts`, `${m[1]}.cts`]) : null;
}

/** The projects under `root` and the files a scan reads in each, filtered by the skip list. */
function planFiles(root, skipSet) {
  forgetFiles();
  const exts = new Set(Object.keys(parse.GRAMMAR_BY_EXT));
  const projects = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !skipSet.has(d.name))
    .map((d) => ({ name: d.name, path: join(root, d.name) }));
  // every path segment is checked against the skip list
  return projects.map((p) => ({ project: p, files: listFiles(p.path, exts).filter((f) => !f.split('/').some((part) => skipSet.has(part) || part.startsWith('.')) && !/\.min\.(js|mjs|cjs)$/.test(f)) }));
}

function gitHead(dir) {
  try { return execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim() || null; } catch { return null; }
}

/**
 * Scan `root`: each sub-folder is a project. `onProgress(done, total, file)` is optional.
 */
async function scan(root, { skip = [], porting = [], onProgress = null } = {}) {
  root = resolve(root);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`root not found: ${root}`);
  await parse.load(Object.keys(parse.GRAMMAR_BY_EXT).map((e) => `x${e}`));
  const skipSet = new Set([...SKIP_DIRS, ...DEFAULT_SKIP, ...skip]);
  const plan = planFiles(root, skipSet);
  const total = plan.reduce((a, p) => a + p.files.length, 0);

  // `inferred` holds the references whose name the project defines more than once, and `uses`
  // the module-level code that names a symbol of an imported file: neither feeds `in` or `out`,
  // so hubs and dead-code grades stay what certain edges make them
  const out = { version: VERSION, root, scanned: new Date().toISOString(), skip: [...skipSet].sort(), porting, projects: [], files: [], symbols: [], imports: [], calls: [], inherits: [], inferred: [], uses: [], dups: [], dead: [] };
  const fileId = new Map();
  let done = 0;
  const sources = new Map(); // fileId → lines (kept for the "name appears in a string" test)
  // Every line of every file is kept for the dead-code pass, so a monorepo of millions of
  // lines would otherwise be read whole into memory. Past the ceiling a file is still counted
  // and its symbols extracted, but its text is not kept, and the output says so.
  const MAX_KEPT_LINES = Number(process.env.ATLAS_CODEGRAPH_MAX_LINES) || 2_000_000;
  let keptLines = 0; let droppedFiles = 0;

  for (const { project, files } of plan) {
    // the commit and, per file, size and mtime: what a later read compares to say how far behind it is
    const pr = { name: project.name, path: project.path, commit: gitHead(project.path), files: 0, lines: 0, symbols: 0, languages: {}, external: {} };
    const pIndex = new Map(); // name → [symbol ids] (top-level, this project)
    const pFiles = [];
    for (const f of files) {
      done += 1;
      if (onProgress) onProgress(done, total, `${project.name}/${f}`);
      let lines, st;
      try { st = statSync(join(project.path, f)); lines = readLines(join(project.path, f)); } catch { continue; }
      const grammar = parse.grammarOf(f);
      const a = parse.analyze(lines.join('\n'), f);
      const id = out.files.length;
      fileId.set(`${project.name}|${f}`, id);
      const rec = { id, project: project.name, path: f, lang: grammar, lines: lines.length, size: st.size, mtime: Math.floor(st.mtimeMs), parsed: Boolean(a), defs: a ? a.defs.length : 0, dynamic: a ? a.dynamic : false, broken: a ? a.broken : false, imports: [], external: [] };
      out.files.push(rec);
      if (keptLines + lines.length <= MAX_KEPT_LINES) { sources.set(id, lines); keptLines += lines.length; } else droppedFiles += 1;
      pFiles.push({ rec, a, lines });
      pr.files += 1; pr.lines += lines.length; pr.languages[grammar] = (pr.languages[grammar] || 0) + 1;
      if (!a) continue;
      for (const d of a.defs) {
        if (!d.top) continue;
        const sid = out.symbols.length;
        const text = normText(lines.slice(d.first - 1, d.last));
        out.symbols.push({ id: sid, file: id, project: project.name, name: d.name, kind: d.kind, line: d.line, first: d.first, last: d.last, size: d.last - d.first + 1, exported: d.exported, hash: sha(text), shape: sha(d.shape), tokens: d.tokens, refs: d.refs, bases: d.bases || [], in: 0, out: 0 });
        if (!pIndex.has(d.name)) pIndex.set(d.name, []);
        pIndex.get(d.name).push(sid);
        pr.symbols += 1;
      }
    }
    // imports, resolved inside the project
    const fileList = files;
    for (const { rec, a } of pFiles) {
      if (!a) continue;
      for (const im of a.imports) {
        const to = resolveImport(im.module, rec.path, fileList, rec.lang);
        if (to != null && fileId.has(`${project.name}|${to}`)) { const toId = fileId.get(`${project.name}|${to}`); rec.imports.push(toId); out.imports.push({ from: rec.id, to: toId }); }
        else if (im.module && !im.module.startsWith('.') && !/^[@~]\//.test(im.module)) { const lib = im.module.split('/')[0].replace(/^@([^/]+)\/.*/, '@$1'); if (!rec.external.includes(lib)) rec.external.push(lib); pr.external[lib] = (pr.external[lib] || 0) + 1; }
      }
    }
    // A name the project defines more than once cannot be tied to one definition. Dropping the
    // reference would make a blast radius look complete when it is not, so it is kept apart as
    // inferred, with every candidate, and never counted in `in` or `out`.
    // (Inferred edges kept beside certain ones: Graphify-Labs/graphify, Apache-2.0.)
    const infer = (s, name, targets, kind) => {
      const to = targets.filter((t) => t !== s.id);
      if (to.length) out.inferred.push({ from: s.id, name, to, candidates: targets.length, kind });
    };
    // inherits: a class whose parent one top-level symbol of the project defines
    for (const s of out.symbols) {
      if (s.project !== project.name) continue;
      for (const b of s.bases || []) {
        const targets = pIndex.get(b);
        if (!targets) continue;
        if (targets.length > 1) { infer(s, b, targets, 'inherits'); continue; }
        if (targets[0] === s.id) continue;
        out.inherits.push({ from: s.id, to: targets[0] });
        out.symbols[targets[0]].in += 1;
      }
    }
    // calls: a name used by a symbol that one top-level symbol of the project defines
    for (const s of out.symbols) {
      if (s.project !== project.name) continue;
      for (const name of s.refs) {
        const targets = pIndex.get(name);
        if (!targets) continue;
        if (targets.length > 1) { infer(s, name, targets, 'calls'); continue; }
        if (targets[0] === s.id) continue;
        out.calls.push({ from: s.id, to: targets[0] });
        s.out += 1; out.symbols[targets[0]].in += 1;
      }
    }
    // module-level code that names a symbol of a file it imports: `app.get('/x', handler)`.
    // Only certain names count, and the defining file itself is left out, because its own
    // `export { x }` lines would put every file in every radius.
    for (const { rec, a } of pFiles) {
      if (!a || !a.moduleRefs) continue;
      for (const name of a.moduleRefs) {
        const targets = pIndex.get(name);
        if (targets && targets.length === 1 && rec.imports.includes(out.symbols[targets[0]].file)) out.uses.push({ file: rec.id, to: targets[0] });
      }
    }
    out.projects.push(pr);
  }

  // duplicates: same text, or same shape, among symbols big enough to mean something
  const portSet = new Set(porting.map(([a, b]) => [a, b].sort().join('|')));
  const isPort = (a, b) => portSet.has([a, b].sort().join('|'));
  const byHash = new Map(), byShape = new Map();
  for (const s of out.symbols) {
    if (s.size < MIN_DUP_LINES || s.tokens < MIN_DUP_TOKENS) continue;
    if (!byHash.has(s.hash)) byHash.set(s.hash, []); byHash.get(s.hash).push(s.id);
    if (!byShape.has(s.shape)) byShape.set(s.shape, []); byShape.get(s.shape).push(s.id);
  }
  const seen = new Set();
  const addDup = (a, b, kind) => {
    const k = `${Math.min(a, b)}|${Math.max(a, b)}`;
    if (seen.has(k)) return; seen.add(k);
    const A = out.symbols[a], B = out.symbols[b];
    out.dups.push({ a, b, kind, lines: Math.min(A.size, B.size), cross: A.project !== B.project, porting: A.project !== B.project && isPort(A.project, B.project) });
  };
  // a group of N identical functions is N*(N-1)/2 pairs: generated code with thousands of
  // identical stubs would turn this into millions of entries, so a group is cut at its first
  // MAX_GROUP members and the cut is counted in the output
  const MAX_GROUP = 200;
  const pairs = (ids, kind) => {
    const g = ids.length > MAX_GROUP ? ids.slice(0, MAX_GROUP) : ids;
    if (ids.length > MAX_GROUP) out.dupGroupsTruncated = (out.dupGroupsTruncated || 0) + 1;
    for (let i = 0; i < g.length; i += 1) for (let j = i + 1; j < g.length; j += 1) addDup(g[i], g[j], kind);
  };
  for (const ids of byHash.values()) pairs(ids, 'identical');
  for (const ids of byShape.values()) pairs(ids, 'shape');
  out.dups.sort((x, y) => y.lines - x.lines);
  out.textKept = { maxLines: MAX_KEPT_LINES, lines: keptLines, filesNotKept: droppedFiles, env: 'ATLAS_CODEGRAPH_MAX_LINES' };
  if (droppedFiles) out.textNotKept = { files: droppedFiles, limitLines: MAX_KEPT_LINES, note: 'dead-code grading used no text from these files' };

  // dead-code candidates: top-level, nothing in the project calls them, graded by the
  // false-positive list. A label, never an action.
  // one pass over the text of each project: identifier → the lines that hold it, so each
  // uncalled symbol is a lookup and not a regex over every line of the project
  const where = new Map(); // project → Map(name → [{file, line}])
  for (const other of out.files) {
    if (!where.has(other.project)) where.set(other.project, new Map());
    const idx = where.get(other.project);
    const lines = sources.get(other.id) || [];
    for (let i = 0; i < lines.length; i += 1) {
      for (const m of lines[i].matchAll(/[A-Za-z_$][\w$]*/g)) {
        let arr = idx.get(m[0]); if (!arr) { arr = []; idx.set(m[0], arr); }
        arr.push({ file: other.id, line: i + 1 });
      }
    }
  }
  for (const s of out.symbols) {
    if (s.in > 0) continue;
    if (!/function|method|class|def/.test(s.kind) && !/_declarator|assignment/.test(s.kind)) continue;
    const f = out.files[s.file];
    // the name anywhere else in the project: another file, or its own file outside the definition
    const name = s.name.replace(/^\$/, '');
    const hits = (where.get(s.project) || new Map()).get(name) || [];
    const elsewhere = hits.some((h) => !(h.file === s.file && h.line >= s.first && h.line <= s.last));
    const entry = /^(main|index|app|server|cli|preload|background)\.|^(main|index|app|__init__|__main__|setup|manage|conftest)\.[a-z]+$/.test(basename(f.path)) || /tests?\//.test(f.path) || /\.test\.|\.spec\.|_test\.|^test_/.test(basename(f.path));
    let grade, why;
    if (elsewhere) { grade = 'uncertain'; why = 'the name appears elsewhere in the project (a string, a comment, a dynamic call)'; }
    else if (f.dynamic) { grade = 'probable'; why = 'nothing calls it, but the file uses dynamic dispatch, IPC by string or FFI'; }
    else if (s.exported) { grade = 'probable'; why = 'nothing in the project calls it, but it is exported: another project or a runtime may'; }
    else if (entry) { grade = 'uncertain'; why = 'it lives in an entry point or a test file'; }
    else { grade = 'certain'; why = 'nothing calls it, the name appears nowhere else, it is not exported, the file has no dynamic calls'; }
    out.dead.push({ symbol: s.id, grade, why });
  }

  // project-level edges: how much two projects share
  const pe = new Map();
  for (const d of out.dups) {
    if (!d.cross) continue;
    const A = out.symbols[d.a].project, B = out.symbols[d.b].project;
    const k = [A, B].sort().join('|');
    if (!pe.has(k)) pe.set(k, { a: k.split('|')[0], b: k.split('|')[1], identical: 0, shape: 0, lines: 0, porting: d.porting });
    const e = pe.get(k); e[d.kind] += 1; e.lines += d.lines;
  }
  out.projectEdges = [...pe.values()].sort((x, y) => y.identical + y.shape - (x.identical + x.shape));
  return out;
}

// ---------------------------------------------------------------------------------------
// reports

function fmt(n) { return n.toLocaleString('en-US'); }

function report(g) {
  const out = [];
  out.push(`scanned   ${g.projects.length} projects · ${fmt(g.files.length)} files · ${fmt(g.files.reduce((a, f) => a + f.lines, 0))} lines · ${fmt(g.symbols.length)} top-level symbols · ${g.scanned.slice(0, 10)}`);
  for (const p of g.projects) out.push(`  ${p.name.padEnd(16)} ${String(p.files).padStart(5)} files ${fmt(p.lines).padStart(9)} lines ${String(p.symbols).padStart(6)} symbols  ${Object.entries(p.languages).map(([l, n]) => `${l} ${n}`).join(', ')}`);
  const cross = g.dups.filter((d) => d.cross && !d.porting), port = g.dups.filter((d) => d.porting), inner = g.dups.filter((d) => !d.cross);
  out.push(`duplicates ${g.dups.length}: ${cross.length} across projects (${cross.filter((d) => d.kind === 'identical').length} identical, ${cross.filter((d) => d.kind === 'shape').length} same shape), ${inner.length} inside a project${port.length ? `, ${port.length} in declared portings (not counted)` : ''}`);
  for (const e of g.projectEdges.filter((e) => !e.porting).slice(0, 12)) out.push(`  ${e.a} ↔ ${e.b}  ${e.identical} identical, ${e.shape} same shape, ${fmt(e.lines)} lines`);
  const dead = { certain: 0, probable: 0, uncertain: 0 };
  for (const d of g.dead) dead[d.grade] += 1;
  out.push(`uncalled  ${g.dead.length} symbols: ${dead.certain} certain, ${dead.probable} probable, ${dead.uncertain} uncertain — labels, never removals`);
  const unread = unreadFiles(g);
  if (unread.length) {
    const per = {};
    for (const f of unread) per[f.project] = (per[f.project] || 0) + 1;
    out.push(`unread    ${unread.length} file${unread.length === 1 ? '' : 's'} probably wrong grammar or unparsed: ${Object.entries(per).map(([p, n]) => `${p} ${n}`).join(', ')}`);
    for (const f of unread.slice(0, UNREAD_SHOWN)) out.push(`  ${f.project}/${f.path}  ${f.broken ? 'syntax errors' : `0 definitions in ${fmt(f.lines)} lines`}`);
    if (unread.length > UNREAD_SHOWN) out.push(`  and ${unread.length - UNREAD_SHOWN} more`);
  }
  return out.join('\n');
}

/**
 * Files the graph most likely did not read. A grammar fixed by extension parses a file in
 * another language without an error, into a few stray nodes, so the file looks normal and its
 * code is missing from every answer. Past UNREAD_LINES lines a file with no definition at all,
 * or one with syntax errors, is far more often misread than truly empty.
 * (Wrong-grammar files that look normal: Graphify-Labs/graphify, Apache-2.0.)
 */
const UNREAD_LINES = 200;
const UNREAD_SHOWN = 10;
function unreadFiles(g) {
  return g.files.filter((f) => f.broken || (f.defs === 0 && f.lines > UNREAD_LINES));
}

/**
 * How far behind the files under the root the graph is: files changed (size or mtime), gone, or
 * new since the scan. Null when the graph is older than this record and cannot say.
 */
function staleness(g) {
  if (!g.files.length || g.files.some((f) => f.mtime == null)) return g.files.length ? null : { changed: [], gone: [], added: [] };
  const paths = new Map(g.projects.map((p) => [p.name, p.path]));
  const changed = [], gone = [];
  const known = new Set();
  for (const f of g.files) {
    known.add(`${f.project}|${f.path}`);
    try {
      const st = statSync(join(paths.get(f.project), f.path));
      if (st.size !== f.size || Math.floor(st.mtimeMs) !== f.mtime) changed.push(`${f.project}/${f.path}`);
    } catch { gone.push(`${f.project}/${f.path}`); }
  }
  const added = [];
  try {
    for (const { project, files } of planFiles(g.root, new Set(g.skip || []))) for (const f of files) if (!known.has(`${project.name}|${f}`)) added.push(`${project.name}/${f}`);
  } catch { /* the root is gone: every file is already counted as gone */ }
  return { changed, gone, added };
}

const STALE_NAMED = 5;
/** The line every read command starts with when the graph is behind; empty when it is not. */
function staleLine(st) {
  if (!st) return 'graph records no file state (scanned before this check): how far behind it is is unknown; scan again';
  const all = [...st.changed, ...st.gone.map((f) => `${f} (gone)`), ...st.added.map((f) => `${f} (new)`)];
  if (!all.length) return '';
  return `graph is ${all.length} file${all.length === 1 ? '' : 's'} behind (scan again): ${all.slice(0, STALE_NAMED).join(', ')}${all.length > STALE_NAMED ? `, and ${all.length - STALE_NAMED} more` : ''}`;
}

function dupsReport(g, { project = null, cross = false } = {}) {
  const rows = g.dups.filter((d) => !d.porting && (!cross || d.cross) && (!project || g.symbols[d.a].project === project || g.symbols[d.b].project === project));
  if (!rows.length) return 'no duplicates';
  return rows.map((d) => {
    const A = g.symbols[d.a], B = g.symbols[d.b];
    const fa = g.files[A.file], fb = g.files[B.file];
    return `${d.kind === 'identical' ? 'identical ' : 'same shape'} ${String(d.lines).padStart(4)} lines  ${A.project}/${fa.path}:${A.first}-${A.last} ${A.name}  ↔  ${B.project}/${fb.path}:${B.first}-${B.last} ${B.name}`;
  }).join('\n');
}

/**
 * The blast radius of a symbol: what calls it or inherits from it, then what calls those,
 * up to `depth` steps. Rings of symbol ids, nearest first.
 */
function impact(g, symbolId, depth = 2) {
  const back = new Map();
  const add = (from, to) => { if (!back.has(to)) back.set(to, []); back.get(to).push(from); };
  for (const e of g.calls) add(e.from, e.to);
  for (const e of g.inherits || []) add(e.from, e.to);
  const seen = new Set([symbolId]);
  const rings = [];
  let frontier = [symbolId];
  for (let d = 0; d < depth && frontier.length; d += 1) {
    const next = [];
    for (const id of frontier) for (const f of back.get(id) || []) if (!seen.has(f)) { seen.add(f); next.push(f); }
    if (next.length) rings.push(next);
    frontier = next;
  }
  return rings;
}

function impactReport(g, project, symbol, depth = 2) {
  // `<file>:<symbol>` picks one definition when the name is defined in several files
  const [fileWanted, nameWanted] = symbol.includes(':') ? [symbol.slice(0, symbol.lastIndexOf(':')).replace(/\\/g, '/'), symbol.slice(symbol.lastIndexOf(':') + 1)] : [null, symbol];
  const all = g.symbols.filter((x) => x.project === project && x.name === nameWanted && (!fileWanted || g.files[x.file].path === fileWanted));
  if (!all.length) return `${symbol} is not a top-level symbol of ${project}`;
  if (all.length > 1) return `${nameWanted} is defined ${all.length} times in ${project}; say which one as <file>:<symbol>:\n` + all.map((x) => `  ${g.files[x.file].path}:${x.first}-${x.last}`).join('\n');
  const s = all[0];
  const rings = impact(g, s.id, depth);
  const where = (t) => `${g.files[t.file].path}:${t.first}-${t.last}`;
  const out = [];
  if (!rings.length) out.push(`nothing in ${project} calls or inherits from ${symbol}`);
  else out.push(...rings.map((ring, i) => `${i + 1} step${i ? 's' : ''} away: ${ring.length}\n` + ring.map((id) => { const t = g.symbols[id]; return `  ${t.name}  ${where(t)}`; }).join('\n')));
  // possible callers: they use the name, but the project defines it more than once
  const possible = (g.inferred || []).filter((e) => e.to.includes(s.id));
  if (possible.length) {
    out.push(`possible callers: ${possible.length} (the name has more than one definition; not followed further)`);
    for (const e of possible) { const t = g.symbols[e.from]; out.push(`  ${t.name}  ${where(t)}  1 of ${e.candidates} definitions named ${e.name}`); }
  }
  const uses = (g.uses || []).filter((u) => u.to === s.id);
  if (uses.length) {
    out.push(`files naming it at module level: ${uses.length}`);
    for (const u of uses) out.push(`  ${g.files[u.file].path}`);
  }
  // every answer says what it could not see, so a short radius is never read as a complete one
  if (!g.inferred) out.push('references not resolved: unknown (the graph predates this count; scan again)');
  else {
    const radius = new Set([s.id, ...rings.flat()]);
    const n = g.inferred.filter((e) => e.to.some((t) => radius.has(t))).length;
    out.push(`${n} reference${n === 1 ? '' : 's'} not resolved (a name defined more than once in ${project})`);
  }
  return out.join('\n');
}

function hubs(g, project = null) {
  const rows = g.symbols.filter((s) => !project || s.project === project).sort((a, b) => b.in - a.in || b.out - a.out).slice(0, 25);
  return rows.map((s) => `${String(s.in).padStart(4)} in ${String(s.out).padStart(3)} out  ${s.project}/${g.files[s.file].path}:${s.first}-${s.last} ${s.name}`).join('\n') || 'no symbols';
}

function deadReport(g, project = null) {
  const order = { certain: 0, probable: 1, uncertain: 2 };
  const rows = g.dead.filter((d) => !project || g.symbols[d.symbol].project === project).sort((a, b) => order[a.grade] - order[b.grade]);
  return rows.map((d) => { const s = g.symbols[d.symbol]; return `${d.grade.padEnd(9)} ${s.project}/${g.files[s.file].path}:${s.first}-${s.last} ${s.name}  — ${d.why}`; }).join('\n') || 'nothing uncalled';
}

// ---------------------------------------------------------------------------------------
// entry

function loadGraph(path) {
  const g = JSON.parse(readFileSync(path, 'utf8'));
  if (!g || g.version !== VERSION || !Array.isArray(g.symbols)) throw new Error(`${path} is not an ATLAS code graph`);
  return g;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const flag = (n) => rest.includes(n);
  const opt = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : null; };
  const pos = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--') && ['--out', '--skip', '--porting', '--project', '--depth'].includes(rest[i - 1])));
  switch (cmd) {
    case 'scan': {
      if (!pos[0]) throw Object.assign(new Error('usage: scan <root> [--out <file.json>] [--skip a,b] [--porting "A|B,C|D"] [--quiet]'), { usage: true });
      const skip = (opt('--skip') || '').split(',').map((s) => s.trim()).filter(Boolean);
      const porting = (opt('--porting') || '').split(',').map((p) => p.split('|').map((s) => s.trim())).filter((p) => p.length === 2 && p[0] && p[1]);
      const quiet = flag('--quiet');
      const g = await scan(pos[0], { skip, porting, onProgress: quiet ? null : (d, t, f) => { if (d % 25 === 0 || d === t) process.stderr.write(`progress ${d}/${t} ${f}\n`); } });
      const out = opt('--out');
      if (out) { mkdirSync(dirname(resolve(out)), { recursive: true }); writeFileSync(out, JSON.stringify(g)); }
      return report(g) + (out ? `\nwritten   ${out}` : '');
    }
    case 'report': case 'dups': case 'hubs': case 'impact': case 'dead': {
      if (cmd === 'impact' && (!pos[1] || !pos[2])) throw Object.assign(new Error('usage: impact <file.json> <project> <symbol> [--depth 2]'), { usage: true });
      const g = loadGraph(pos[0]);
      // every read says first how far behind the code the graph is
      const st = staleness(g);
      const head = staleLine(st);
      // "nothing calls it" about a file edited since the scan is the verdict most likely to be
      // false and the costliest to act on, so it is refused rather than warned
      if (cmd === 'dead' && st && head) return `${head}\nrefused: uncalled verdicts come only from a graph that matches the code`;
      const body = cmd === 'report' ? report(g)
        : cmd === 'dups' ? dupsReport(g, { project: opt('--project'), cross: flag('--cross') })
          : cmd === 'hubs' ? hubs(g, pos[1] || null)
            : cmd === 'impact' ? impactReport(g, pos[1], pos[2], Number(opt('--depth') || 2))
              : deadReport(g, pos[1] || null);
      return head ? `${head}\n${body}` : body;
    }
    default: throw Object.assign(new Error('usage: node codegraph.mjs <scan|report|dups|hubs|dead|impact> …'), { usage: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write((await main(process.argv.slice(2))) + '\n');
  } catch (err) {
    process.stderr.write(`codegraph: ${err.message}\n`);
    process.exitCode = err.usage ? 2 : 1;
  }
  // Inside an Electron utility process the channel to the parent keeps the process alive
  // for ever; under plain Node it ends by itself and this line is never reached.
  if (process.parentPort) process.stdout.write('', () => process.exit(process.exitCode || 0));
}

export { scan, report, dupsReport, hubs, deadReport, impact, impactReport, staleness, staleLine, unreadFiles, loadGraph, resolveImport, main, VERSION, DEFAULT_SKIP };
