/**
 * ATLAS — what a note says that can be checked with no link to any code. Most notes have no link:
 * a decision, a location, a status. They go stale too, and nothing said so.
 *
 *   gone     the note names a path that is no longer there
 *   broken   the text holds a control character, or a path split across a line, where a backslash
 *            in a Windows path was read as an escape (`\atlas` written as a bell and `tlas`)
 *   version  the note's description, or its line in MEMORY.md, gives a version of a project, and
 *            the project is at another
 *   aged     the project the note is about has moved a lot since the note was last touched; not
 *            said of a rule or a preference (type feedback or user)
 *
 * Reads only. `gone` and `version` are facts about the note. `aged` only says it is worth a look:
 * many commits do not make a note false.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

const AGED_COMMITS = 100;
const VERSION = /(?<![\w.])v?(\d+\.\d+\.\d+)(?![\w.])/g;

// a section headed as history says where things were, not where they are
const HISTORY = /^(#{1,6})\s*(?:storia|cronologia|history|changelog|log)\b/i;

function strip(text) {
  const kept = [];
  let skip = 0;
  for (const line of text.replace(/<private>[\s\S]*?<\/private>/g, ' ').replace(/```[\s\S]*?```/g, ' ').split('\n')) {
    const h = line.match(/^(#{1,6})\s/);
    if (h && skip && h[1].length <= skip) skip = 0;
    const past = line.match(HISTORY);
    if (past) skip = past[1].length;
    if (!skip) kept.push(line);
  }
  return kept.join('\n');
}

function meta(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out = { name: '', description: '', modified: null, type: '' };
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const f = line.match(/^\s*(name|description|modified|type):\s*(.*)$/);
    if (f) out[f[1]] = f[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * Paths a note names, as written: rooted ones (a drive, `~/`, `Desktop\`), and inside backticks a
 * relative one with a separator. A rooted path may hold spaces, so what follows it comes along and
 * `judgePath` tries where it could end. Pure.
 */
function pathsIn(text) {
  const found = new Set();
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const t = m[1].trim();
    if (/[\\/]/.test(t) && !/[\s*<>{}|$?()=]/.test(t) && !/^(https?:|\/\/|-|\.\.?[\\/]|\.[\w-]+[\\/]|~[\\/]\.)/.test(t)) found.add(t);
    else if (/^(?:[A-Za-z]:\\|Desktop\\)/.test(t) && !/[<>{}|*?$]/.test(t)) found.add(t);
  }
  for (const m of text.matchAll(/(?<![\w/\\`])(?:[A-Za-z]:\\|Desktop\\)[^\n`"'()<>|*?,;{}]+/g)) found.add(m[0].trim());
  return [...found].map((p) => p.replace(/[.,:;]+$/, '').replace(/[\\/]+$/, '')).filter((p) => p.length > 3 && !/\.\.\.|…|\{|\}/.test(p));
}

const ROOTED = /^(?:[A-Za-z]:[\\/]|Desktop\\|\/)/;

// a sentence that says the path is gone, or where something was, is history and not a claim
const TOLD_GONE = /cestin|cancellat|eliminat|rimoss|\btolt[aoie]\b|non (?:c'e'|c'è|ci sono|esiste|esistono) piu|\bfino al\b|\b(?:era|erano|stava|stavano)\b|\bdeleted\b|\bremoved\b|\btrashed\b|\bno longer\b|\bused to\b/i;

/** Whether every place the note names `p` is a sentence saying it is gone or was. Pure. */
function toldGone(text, p) {
  let at = text.indexOf(p);
  if (at < 0) return false;
  for (; at >= 0; at = text.indexOf(p, at + p.length)) {
    const before = text.slice(0, at);
    const stop = before.search(/[.;]\s[^.;]*$/);
    const start = Math.max(before.lastIndexOf('\n'), stop < 0 ? -1 : stop + 1);
    const after = text.slice(at + p.length);
    const end = after.search(/[.;]\s|\n/);
    const sentence = `${before.slice(start + 1)} ${end < 0 ? after : after.slice(0, end)}`;
    if (!TOLD_GONE.test(sentence)) return false;
  }
  return true;
}

/** Escapes a writer took for backslashes: a control character, or a backticked path broken over a line. Pure. */
function brokenIn(text) {
  const out = [];
  const control = text.match(/[\x00-\x08\x0b\x0c\x0e-\x1f]|\r(?!\n)/);
  if (control) {
    const i = control.index;
    out.push(`holds a control character after "${text.slice(Math.max(0, i - 25), i).replace(/\s+/g, ' ')}": a backslash read as an escape`);
  }
  // a line that leaves a backtick open and runs straight into the next one: `\r` read as a line break
  const lines = text.replace(/```[\s\S]*?```/g, '').split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i += 1) {
    const open = lines[i].lastIndexOf('`');
    if ((lines[i].match(/`/g) || []).length % 2 && /^`\S+$/.test(lines[i].slice(open)) && /^[^`\s]+`/.test(lines[i + 1])) {
      out.push(`breaks ${lines[i].slice(open, open + 40)} across a line: a backslash read as an escape`);
      break;
    }
  }
  return out;
}

/**
 * What can be said of a path. `gone` is said only when it cannot be something else: a rooted path
 * whose folder is there and whose next part is not, or a relative one whose name is nowhere in the
 * project and whose first folders are there. A short relative path may belong to another project,
 * so it says nothing. `files` is what the roots hold.
 */
function judgePath(p, roots, home = homedir(), files = null) {
  p = p.replace(/[\x00-\x1f]/g, '');
  if (ROOTED.test(p)) {
    // walked folder by folder: a part that is not there may just be followed by more words
    const absolute = /^[A-Za-z]:[\\/]|^\//.test(p);
    const parts = p.split(/[\\/]+/).filter(Boolean);
    if (p.startsWith('/') && parts.length < 3) return { state: 'unknown' };
    let at = absolute ? (/^[A-Za-z]:/.test(p) ? `${parts.shift()}${sep}` : sep) : home;
    if (!existsSync(at)) return { state: 'unknown' };
    const walked = [];
    for (let i = 0; i < parts.length; i += 1) {
      const words = parts[i].split(' ');
      let next = null;
      for (let n = words.length; n > 0 && !next; n -= 1) {
        const try_ = join(at, words.slice(0, n).join(' ').replace(/[.,:;]+$/, ''));
        if (existsSync(try_)) next = { full: try_, whole: n === words.length };
      }
      if (!next) return { state: 'gone', strong: true, shown: [...(absolute ? [] : []), ...walked, parts[i].slice(0, 40)].join('\\') };
      walked.push(parts[i]);
      at = next.full;
      if (!next.whole) return { state: 'there', full: at };
    }
    return { state: 'there', full: at };
  }
  const clean = p.replace(/\\/g, '/');
  for (const base of [home, ...roots]) if (existsSync(join(base, clean))) return { state: 'there', full: join(base, clean) };
  const parts = clean.split('/').filter(Boolean);
  if (parts.length < 2) return { state: 'unknown' };
  const name = parts[parts.length - 1];
  const dirs = parts.slice(0, -1).join('/');
  const inRoot = roots.find((r) => existsSync(join(r, dirs)));
  if (!inRoot) return { state: 'unknown' };
  if (files && files.some((f) => f.split('/').includes(name))) return { state: 'unknown' };
  return { state: 'gone', strong: false, shown: p };
}

function projectOf(start) {
  let dir = start;
  try { if (statSync(dir).isFile()) dir = dirname(dir); } catch { return null; }
  for (let i = 0; i < 8; i++) {
    for (const f of [join(dir, '.claude-plugin', 'plugin.json'), join(dir, 'package.json')]) {
      try {
        const v = JSON.parse(readFileSync(f, 'utf8'));
        if (v.name && v.version) return { dir, name: String(v.name), version: String(v.version) };
      } catch { /* next */ }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function commitsSince(dir, when, cache) {
  const key = `${dir}|${when}`;
  if (cache.has(key)) return cache.get(key);
  let n = 0;
  try { n = Number(execFileSync('git', ['-C', dir, 'rev-list', '--count', `--since=${when}`, 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim()) || 0; } catch { /* not a repository */ }
  cache.set(key, n);
  return n;
}

function tracked(dir, cache) {
  if (!cache.has(dir)) {
    let list = [];
    try { list = execFileSync('git', ['-C', dir, 'ls-files'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 3000 }).split(/\r?\n/).filter(Boolean); } catch { /* not a repository */ }
    cache.set(dir, list);
  }
  return cache.get(dir);
}

/**
 * What can be said of one note. Pure apart from looking at the disk. A relative path is judged only
 * against the folders the note names and the roots it is about: `src/x.js` in a note about another
 * project says nothing about this one. `index` is the note's line in MEMORY.md, which every session
 * loads, so what it says is checked too.
 */
function checkNote(slug, raw, { roots = [], home = homedir(), projects = [], cache = new Map(), mtime = null, index = '' } = {}) {
  const text = strip(raw);
  const m = meta(raw);
  const body = text.replace(/^---[\s\S]*?\n---/, '');
  const all = `${m.description}\n${body}`;
  const out = [];
  for (const reason of brokenIn(raw)) out.push({ slug, grade: 'broken', reason });
  const mine = new Map();
  const shown = new Set();
  const found = pathsIn(`${all}\n${index}`);
  const rooted = new Map(found.filter((p) => ROOTED.test(p)).map((p) => [p, judgePath(p, [], home)]));
  // the name of a project counts as a mention only as a whole word
  const words = new Set(`${slug.replace(/-/g, ' ')} ${m.name} ${m.description}`.toLowerCase().split(/[^a-z0-9-]+/));
  const named = [...rooted.values()].filter((j) => j.state === 'there').map((j) => { try { return statSync(j.full).isDirectory() ? j.full : dirname(j.full); } catch { return null; } }).filter(Boolean);
  const about = roots.filter((r) => { const pr = projectOf(r); return named.some((n) => n.startsWith(r)) || (pr && words.has(pr.name.toLowerCase())); });
  const bases = [...new Set([...named, ...about])];
  const files = bases.flatMap((b) => tracked(b, cache));
  for (const p of found) {
    const j = rooted.get(p) || (bases.length ? judgePath(p, bases, home, files) : { state: 'unknown' });
    if (j.state === 'gone' && !shown.has(j.shown) && !toldGone(`${all}\n${index}`, p)) { shown.add(j.shown); out.push({ slug, grade: j.strong ? 'gone' : 'gone?', reason: `names ${j.shown}, which is no longer there` }); }
    if (j.state === 'there') { const pr = projectOf(j.full); if (pr && !/[\\/]\.claude[\\/]/.test(pr.dir)) mine.set(pr.dir, pr); }
  }
  for (const pr of projects) if (words.has(pr.name.toLowerCase())) mine.set(pr.dir, pr);
  for (const pr of mine.values()) {
    for (const [where, said] of [['says', m.description], ['MEMORY.md says', index]]) {
      const versions = [...said.matchAll(VERSION)].map((v) => v[1]);
      const line = `${where} ${versions[0]}, ${pr.name} is at ${pr.version}`;
      if (versions.length && words.has(pr.name.toLowerCase()) && !versions.includes(pr.version) && !out.some((o) => o.reason === line)) out.push({ slug, grade: 'version', reason: line });
    }
    const when = m.modified || mtime;
    // a rule or a preference does not age with the code: only a note about the project does
    if (when && !/^(feedback|user)$/.test(m.type)) {
      const n = commitsSince(pr.dir, when, cache);
      if (n >= AGED_COMMITS) out.push({ slug, grade: 'aged', reason: `${n} commits in ${pr.name} since this note was last touched` });
    }
  }
  return out;
}

/** Each note's line in MEMORY.md, by slug. */
function indexLines(vault) {
  const out = new Map();
  let text = '';
  try { text = readFileSync(join(vault, 'MEMORY.md'), 'utf8'); } catch { return out; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/\]\(([^)]+?)\.md\)\s*(.*)$/);
    if (m) out.set(m[1].split(/[\\/]/).pop(), m[2]);
  }
  return out;
}

/** Every note of a vault, worst first. */
function checkVault(vault, { roots = [], home = homedir() } = {}) {
  const projects = roots.map(projectOf).filter(Boolean);
  const cache = new Map();
  const index = indexLines(vault);
  const out = [];
  for (const f of readdirSync(vault)) {
    if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
    const file = join(vault, f);
    let raw; try { raw = readFileSync(file, 'utf8'); } catch { continue; }
    const slug = f.slice(0, -3);
    out.push(...checkNote(slug, raw, { roots: roots.map((r) => resolve(r)), home, projects, cache, index: index.get(slug) || '', mtime: statSync(file).mtime.toISOString() }));
  }
  const order = { gone: 0, broken: 1, version: 2, 'gone?': 3, aged: 4 };
  return out.sort((a, b) => order[a.grade] - order[b.grade] || a.slug.localeCompare(b.slug));
}

function report(items) {
  if (!items.length) return 'facts     nothing to say about the notes with no code link';
  const aged = items.filter((i) => i.grade === 'aged');
  const rest = items.filter((i) => i.grade !== 'aged');
  const out = [`facts     ${rest.length} to look at${aged.length ? `, and ${aged.length} notes older than a lot of work (only worth a look)` : ''}`];
  for (const i of rest) out.push(`  ${i.grade.padEnd(8)}${i.slug}  ${i.reason}`);
  return out.join('\n');
}

export { pathsIn, judgePath, toldGone, brokenIn, checkNote, checkVault, report, projectOf };
