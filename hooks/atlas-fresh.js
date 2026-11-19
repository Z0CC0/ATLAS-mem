#!/usr/bin/env node
// atlas-fresh — SessionStart and SubagentStart. Runs the memory's own check at the start of a
// session and says, in one line per note and at most five, which notes may no longer be true:
// nobody remembers to run a check. Changes no note. Silent when all is well, on a compaction,
// with no vault, or with `"fresh": false` in the user atlas.json; gives up after a few seconds;
// exit 0 always.
//
// A subagent starts with none of the session's context, so it would report a stale note as
// current. It gets the same lines. The session's own result is kept for REUSE_MS in the temp
// folder and handed to its subagents, so a run of subagents does not pay the check each time.
// (Memory handed to subagents at their start: thedotmack/claude-mem, Apache-2.0.)
'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawnSync } = require('child_process');
const { vaultFor, userConfig } = require('./atlas-vault');

const MAX_NOTES = 5;
const TIMEOUT_MS = 6000;
const REUSE_MS = 10 * 60 * 1000;
const EVENTS = new Set(['SessionStart', 'SubagentStart']);

/** The line the model reads. Pure: `items` is what `memcheck fresh --json` printed. */
function say(items) {
  if (!items.length) return null;
  const shown = items.slice(0, MAX_NOTES).map((i) => `- ${i.slug}: ${i.reason}`);
  const more = items.length > MAX_NOTES ? [`and ${items.length - MAX_NOTES} more: atlas memory, is it still true?`] : [];
  return ['[atlas memory] These notes may no longer be true. Do not rely on them before checking:', ...shown, ...more].join('\n');
}

const cacheFile = (id) => path.join(os.tmpdir(), `atlas-fresh-${String(id).replace(/[^\w-]/g, '').slice(0, 60)}.json`);

/** The session's last result for this vault, when it is recent enough to stand for now. */
function reused(id, vault, now = Date.now()) {
  if (!id) return null;
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile(id), 'utf8'));
    return c && c.vault === vault && now - c.at < REUSE_MS && Array.isArray(c.items) ? c.items : null;
  } catch { return null; }
}

function check(input, vault) {
  const tool = path.join(__dirname, '..', 'tools', 'memcheck.mjs');
  const r = spawnSync(process.execPath, [tool, 'fresh', vault, '--root', input.cwd || process.cwd(), '--json'], { encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true });
  if (r.status !== 0 || !r.stdout) return null;
  const items = JSON.parse(r.stdout);
  if (input.session_id) {
    try { fs.writeFileSync(cacheFile(input.session_id), JSON.stringify({ vault, at: Date.now(), items }), { mode: 0o600 }); } catch { /* checked again next time */ }
  }
  return items;
}

function main() {
  let input = {}; try { if (!process.stdin.isTTY) input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { input = {}; }
  try {
    const event = input.hook_event_name;
    if (!EVENTS.has(event) || input.source === 'compact' || userConfig().fresh === false) return;
    const vault = vaultFor(input.cwd);
    if (!vault || !fs.existsSync(vault)) return;
    const items = (event === 'SubagentStart' && reused(input.session_id, vault)) || check(input, vault);
    const text = items && say(items);
    if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
  } catch { /* exit 0 */ }
}
// ATLAS_SKIP_HOOKS=name,name (or `all`) makes a hook do nothing for one run: for a bench that
// measures one hook without the others, and for finding which hook is behind a problem.
if (require.main === module && !/(?:^|[,\s])(?:all|fresh)(?:[,\s]|$)/i.test(process.env.ATLAS_SKIP_HOOKS || '')) { main(); process.exit(0); }
module.exports = { say, reused, cacheFile, MAX_NOTES, REUSE_MS };
