#!/usr/bin/env node
// atlas-recall — UserPromptSubmit. Brings the notes a request is about, so nobody has to ask the
// memory: at most three, one line each, each once a session. A note says more where it is rare:
// a word every note has counts for almost nothing, a word only one note has counts for a lot. No
// model and no network. Silent with no vault, on a short prompt or a slash command, when nothing
// reaches the bar, or with `"recall": false` in the user atlas.json; exit 0 always.
'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path');
const { vaultFor, userConfig } = require('./atlas-vault');

const MAX_NOTES = 3;
const MAX_LINE = 170;
// How much two rare words weigh, about: below it a match is more likely chance than a note.
const BAR = 4.5;
const STOP = new Set(['della', 'delle', 'dello', 'degli', 'nella', 'nelle', 'sulle', 'sulla', 'quando', 'perche', 'posso', 'devono', 'essere', 'viene', 'vanno', 'prima', 'anche', 'stesso', 'about', 'which', 'there', 'their', 'would', 'should', 'could', 'where', 'these', 'those', 'questo', 'questa', 'quello', 'quella', 'allora', 'adesso', 'sempre', 'ancora', 'fatto', 'fare', 'solo', 'tutto', 'tutti', 'tutte', 'cosa', 'come', 'dove', 'after', 'before', 'while', 'being', 'please', 'grazie', 'voglio', 'vorrei', 'serve', 'dobbiamo', 'poter', 'possiamo']);
const wordsOf = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 5 && !STOP.has(w));
const stem = (w) => w.slice(0, 5);

function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) { const f = line.match(/^(name|description):\s*(.*)$/); if (f) meta[f[1]] = f[2].replace(/^["']|["']$/g, ''); }
  return { meta, body: text.slice(m[0].length) };
}

/** Every note: its slug, its description, the stems of its head and of its body. Private parts never read. */
function readNotes(vault) {
  const out = [];
  for (const f of fs.readdirSync(vault)) {
    if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
    let text; try { text = fs.readFileSync(path.join(vault, f), 'utf8'); } catch { continue; }
    const { meta, body } = frontmatter(text.replace(/<private>[\s\S]*?<\/private>/g, ' '));
    out.push({ slug: f.slice(0, -3), description: meta.description || meta.name || '', head: new Set(wordsOf(`${f.slice(0, -3).replace(/-/g, ' ')} ${meta.name || ''} ${meta.description || ''}`).map(stem)), body: new Set(wordsOf(body).map(stem)) });
  }
  return out;
}

/** The notes a prompt is about, best first. Pure. */
function rank(prompt, notes, bar = BAR) {
  const query = new Set(wordsOf(prompt).map(stem));
  if (!query.size || !notes.length) return [];
  const df = new Map();
  for (const q of query) df.set(q, notes.reduce((n, x) => n + (x.head.has(q) || x.body.has(q) ? 1 : 0), 0));
  const idf = (q) => Math.log((notes.length + 1) / (df.get(q) + 0.5));
  return notes.map((n) => {
    let score = 0, inHead = false;
    for (const q of query) { if (n.head.has(q)) { score += 2 * idf(q); inHead = true; } else if (n.body.has(q)) score += idf(q); }
    return { note: n, score, inHead };
  }).filter((r) => r.inHead && r.score >= bar).sort((a, b) => b.score - a.score);
}

const seenFile = (id) => path.join(os.tmpdir(), `atlas-recall-${String(id).replace(/[^\w-]/g, '').slice(0, 60)}.json`);
function readSeen(id) { try { return new Set(JSON.parse(fs.readFileSync(seenFile(id), 'utf8'))); } catch { return new Set(); } }

function suspects(vault) {
  try {
    const side = JSON.parse(fs.readFileSync(path.join(vault, '.atlas', 'links.json'), 'utf8'));
    return new Set(Object.entries(side.notes || {}).filter(([, e]) => e.trust === 'suspect').map(([s]) => s));
  } catch { return new Set(); }
}

function lines(found, vault, bad) {
  return [`[atlas recall] Notes in ${vault} that may apply. Read one before relying on it, and check it against the code: a note is a claim about the past.`,
    ...found.map((r) => { const d = r.note.description.length > MAX_LINE ? r.note.description.slice(0, MAX_LINE - 1) + '…' : r.note.description; return `- ${r.note.slug}${bad.has(r.note.slug) ? ' (SUSPECT: its code has changed)' : ''}: ${d}`; })].join('\n');
}

function respond(input) {
  if (userConfig().recall === false) return null;
  const prompt = String(input.prompt || '').trim();
  if (prompt.length < 12 || prompt.startsWith('/')) return null;
  const vault = vaultFor(input.cwd);
  if (!vault || !fs.existsSync(vault)) return null;
  const seen = readSeen(input.session_id);
  const found = rank(prompt, readNotes(vault)).filter((r) => !seen.has(r.note.slug)).slice(0, MAX_NOTES);
  if (!found.length) return null;
  if (input.session_id) {
    for (const r of found) seen.add(r.note.slug);
    try { fs.writeFileSync(seenFile(input.session_id), JSON.stringify([...seen]), { mode: 0o600 }); } catch { /* shown again, no harm */ }
  }
  return lines(found, vault, suspects(vault));
}

function main() {
  let input = {}; try { if (!process.stdin.isTTY) input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { input = {}; }
  try {
    if (input.hook_event_name !== 'UserPromptSubmit') return;
    const text = respond(input);
    if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }));
  } catch { /* exit 0 */ }
}
// ATLAS_SKIP_HOOKS=name,name (or `all`) makes a hook do nothing for one run: for a bench that
// measures one hook without the others, and for finding which hook is behind a problem.
if (require.main === module && !/(?:^|[,\s])(?:all|recall)(?:[,\s]|$)/i.test(process.env.ATLAS_SKIP_HOOKS || '')) { main(); process.exit(0); }
module.exports = { rank, readNotes, respond, wordsOf, BAR, MAX_NOTES };
