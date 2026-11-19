#!/usr/bin/env node
// atlas-labels — PostToolUse on Grep and Read. When a result names a symbol that
// carries a label (SUPERSEDED, WRONG, CANONICAL, …), the label is attached to the
// result as additional context. It never removes or changes a result: the point is
// not to hide the old code but to make it impossible to find without the warning.
//
// The labels live in `<vault>/.atlas/labels.json`, written by `tools/labels.mjs`.
// The vault is found by `atlas-vault.js`, the rule that tool follows too: a project's
// `.atlas.json` vault only when `~/.claude/atlas.json` confirms it, then the user's vault,
// then the Claude Code memory folder of the working directory. No vault, no labels: the
// hook is silent and costs one failed stat.
//
// On a Read it also brings the notes `<vault>/.atlas/links.json` ties to the file opened, one
// line each and at most three, each file once a session: a note about the code comes back
// where the code is, not only when the prompt happens to use the note's words. A file no note
// is linked to adds nothing.
// (Notes surfaced when their file is read: thedotmack/claude-mem, Apache-2.0.)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_LINES = 8;
const MAX_NOTES = 3;
const MAX_LINE = 170;

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const { vaultFor } = require('./atlas-vault');

// The text a result carries, whatever shape the tool gave it.
function textOf(value, depth) {
  if (typeof value === 'string') return value;
  if (!value || depth > 4) return '';
  if (Array.isArray(value)) return value.map((v) => textOf(v, depth + 1)).join('\n');
  if (typeof value === 'object') return Object.values(value).map((v) => textOf(v, depth + 1)).join('\n');
  return '';
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function describe(e) {
  const where = [e.project, e.file].filter(Boolean).join(', ');
  const head = `${e.symbol}${where ? ` (${where})` : ''} is ${e.label} since ${e.when}`;
  return `${head}${e.to ? `: use ${e.to} instead` : ''}. Why: ${e.why}`;
}

function labelLines(vault, input) {
  const table = readJson(path.join(vault, '.atlas', 'labels.json'));
  if (!table || !Array.isArray(table.labels) || !table.labels.length) return [];
  const text = textOf(input.tool_response, 0) + '\n' + textOf(input.tool_input, 0);
  const hits = [];
  for (const e of table.labels) {
    if (!e || typeof e.symbol !== 'string') continue;
    if (new RegExp(`(?<![\\w$])${escape(e.symbol)}(?![\\w$])`).test(text)) hits.push(e);
  }
  if (!hits.length) return [];
  const lines = hits.slice(0, MAX_LINES).map(describe);
  if (hits.length > MAX_LINES) lines.push(`… and ${hits.length - MAX_LINES} more labelled symbols in this result`);
  return ['ATLAS labels on this result:', ...lines];
}

// The spelling `memcheck link` records a repository in: absolute, forward slashes, and lower
// case on Windows, where the same file can arrive as C:\ or c:/.
function samePath(p) {
  const abs = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/** The notes linked to `file`: those linked to it first, then those that depend on code in it. */
function notesFor(side, file) {
  if (!side || !side.notes || typeof side.notes !== 'object') return [];
  const want = samePath(file);
  const at = (repo, rel) => typeof repo === 'string' && typeof rel === 'string' && samePath(path.join(repo, rel)) === want;
  const hits = [];
  for (const [slug, e] of Object.entries(side.notes)) {
    const links = e && Array.isArray(e.links) ? e.links : [];
    const direct = links.some((l) => l && at(l.repo, l.file));
    if (direct || links.some((l) => l && Array.isArray(l.deps) && l.deps.some((d) => d && at(l.repo, d.file)))) hits.push({ slug, trust: e.trust, direct });
  }
  // a suspect note is the one most likely to mislead an edit, so it is never the one cut
  const rank = (h) => (h.direct ? 0 : 2) + (h.trust === 'suspect' ? 0 : 1);
  return hits.sort((a, b) => rank(a) - rank(b));
}

function descriptionOf(vault, slug) {
  if (slug !== path.basename(slug)) return '';
  try {
    const head = fs.readFileSync(path.join(vault, `${slug}.md`), 'utf8').slice(0, 4096);
    const fm = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const m = fm && fm[1].match(/^description:\s*(.*)$/m);
    const d = m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
    return d.length > MAX_LINE ? d.slice(0, MAX_LINE - 1) + '…' : d;
  } catch { return ''; }
}

const seenFile = (id) => path.join(os.tmpdir(), `atlas-filenotes-${String(id).replace(/[^\w-]/g, '').slice(0, 60)}.json`);
function readSeen(id) { try { return new Set(JSON.parse(fs.readFileSync(seenFile(id), 'utf8'))); } catch { return new Set(); } }

function noteLines(vault, input) {
  const file = input.tool_input && input.tool_input.file_path;
  if (input.tool_name !== 'Read' || typeof file !== 'string' || !file) return [];
  const side = readJson(path.join(vault, '.atlas', 'links.json'));
  const key = samePath(path.resolve(input.cwd || process.cwd(), file));
  const hits = notesFor(side, key);
  if (!hits.length) return [];
  const seen = input.session_id ? readSeen(input.session_id) : new Set();
  if (seen.has(key)) return [];
  if (input.session_id) {
    seen.add(key);
    try { fs.writeFileSync(seenFile(input.session_id), JSON.stringify([...seen]), { mode: 0o600 }); } catch { /* shown again, no harm */ }
  }
  const lines = hits.slice(0, MAX_NOTES).map((h) => {
    const trust = h.trust === 'suspect' ? 'SUSPECT: its code has changed' : (h.trust || 'unverified');
    const d = descriptionOf(vault, h.slug);
    return `- ${h.slug} (${trust}${h.direct ? '' : ', through code it depends on'})${d ? `: ${d}` : ''}`;
  });
  if (hits.length > MAX_NOTES) lines.push(`and ${hits.length - MAX_NOTES} more: memcheck impact on this file`);
  return ['ATLAS notes linked to this file. Read one before an edit it may govern; a note is a claim about the past:', ...lines];
}

function respond(input) {
  if (input.tool_name !== 'Grep' && input.tool_name !== 'Read') return null;
  const vault = vaultFor(input.cwd);
  if (!vault) return null;
  const lines = [...labelLines(vault, input), ...noteLines(vault, input)];
  if (!lines.length) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: lines.join('\n'),
    },
  };
}

function main() {
  if (process.stdin.isTTY) return;
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    let input;
    try { input = JSON.parse(raw); } catch { return; }
    let out = null;
    try { out = respond(input || {}); } catch { return; }
    if (out) process.stdout.write(JSON.stringify(out));
  });
}

// ATLAS_SKIP_HOOKS=name,name (or `all`) makes a hook do nothing for one run: for a bench that
// measures one hook without the others, and for finding which hook is behind a problem.
if (require.main === module && !/(?:^|[,\s])(?:all|labels)(?:[,\s]|$)/i.test(process.env.ATLAS_SKIP_HOOKS || '')) main();
module.exports = { respond, vaultFor, notesFor, MAX_NOTES };
