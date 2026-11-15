#!/usr/bin/env node
// atlas-fresh — SessionStart. Runs the memory's own check at the start of a session and says, in
// one line per note and at most five, which notes may no longer be true: nobody remembers to run
// a check. Looks and writes nothing. Silent when all is well, on a compaction, with no vault, or
// with `"fresh": false` in the user atlas.json; gives up after a few seconds; exit 0 always.
'use strict';
const fs = require('fs'); const path = require('path');
const { spawnSync } = require('child_process');
const { vaultFor, userConfig } = require('./atlas-vault');

const MAX_NOTES = 5;
const TIMEOUT_MS = 6000;

/** The line the model reads. Pure: `items` is what `memcheck fresh --json` printed. */
function say(items) {
  if (!items.length) return null;
  const shown = items.slice(0, MAX_NOTES).map((i) => `- ${i.slug}: ${i.reason}`);
  const more = items.length > MAX_NOTES ? [`and ${items.length - MAX_NOTES} more: atlas memory, is it still true?`] : [];
  return ['[atlas memory] These notes may no longer be true. Do not rely on them before checking:', ...shown, ...more].join('\n');
}

function main() {
  let input = {}; try { if (!process.stdin.isTTY) input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { input = {}; }
  try {
    if (input.hook_event_name !== 'SessionStart' || input.source === 'compact' || userConfig().fresh === false) return;
    const vault = vaultFor(input.cwd);
    if (!vault || !fs.existsSync(vault)) return;
    const tool = path.join(__dirname, '..', 'tools', 'memcheck.mjs');
    const r = spawnSync(process.execPath, [tool, 'fresh', vault, '--root', input.cwd || process.cwd(), '--json'], { encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true });
    if (r.status !== 0 || !r.stdout) return;
    const text = say(JSON.parse(r.stdout));
    if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }));
  } catch { /* exit 0 */ }
}
// ATLAS_SKIP_HOOKS=name,name (or `all`) makes a hook do nothing for one run: for a bench that
// measures one hook without the others, and for finding which hook is behind a problem.
if (require.main === module && !/(?:^|[,\s])(?:all|fresh)(?:[,\s]|$)/i.test(process.env.ATLAS_SKIP_HOOKS || '')) { main(); process.exit(0); }
module.exports = { say, MAX_NOTES };
