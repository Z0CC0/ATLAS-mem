#!/usr/bin/env node
// atlas-auto — Stop. Off until `atlas memory auto on` puts "memoryAuto" in the user atlas.json:
// then every few turns it gives the model one more turn to write what was said into the vault,
// so nobody has to ask. The cost is that extra turn, which is why it is off and why the number
// can be chosen. Silent without a transcript or under stop_hook_active; exit 0 always.
'use strict';
const fs = require('fs'); const path = require('path');
const { vaultFor, userConfig, claudeDir } = require('./atlas-vault');

const MARK = '[atlas auto]';
const EVERY = 5;

/** How many turns between two writes: `true` is the default, a number is the person's choice. */
const everyOf = (v) => (v === true ? EVERY : Number.isInteger(v) && v > 0 ? v : 0);

/** What the person typed since the last write. Pure. */
function turnsSince(jsonl) {
  let n = 0;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== 'user' || e.isMeta) continue;
    const c = e.message && e.message.content;
    const blocks = Array.isArray(c) ? c : [];
    if (blocks.some((b) => b && b.type === 'tool_result')) continue;
    const t = (typeof c === 'string' ? c : blocks.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n')).trim();
    if (t.includes(MARK)) { n = 0; continue; }
    if (!t || t.startsWith('<') || t.startsWith('[Request interrupted') || t.startsWith('Caveat:') || /^Stop hook feedback/i.test(t)) continue;
    n += 1;
  }
  return n;
}

/** The vault, made in Claude Code's own memory folder when there is none yet. */
function vaultMade(cwd) {
  const found = vaultFor(cwd);
  if (found) return found;
  const dir = path.join(claudeDir(), 'projects', path.resolve(cwd || process.cwd()).replace(/[^A-Za-z0-9]/g, '-'), 'memory');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ask(n, vault) {
  return `${MARK} Automatic memory is on. In the vault ${vault}, write a note per atlas-memory write.md for each thing worth keeping from the last ${n} turns: facts, decisions, preferences, small things the person said about themselves or the work. Add \`source: auto\` to the frontmatter. Update a note that already says it rather than adding one. Skip what the code or the history already says. Never the value of a secret, and nothing inside <private>. At most three notes. If there is nothing, write nothing. Say nothing about this and stop.`;
}

function main() {
  let input = {}; try { if (!process.stdin.isTTY) input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { input = {}; }
  try {
    if (input.hook_event_name !== 'Stop' || input.stop_hook_active) return;
    const every = everyOf(userConfig().memoryAuto);
    if (!every || typeof input.transcript_path !== 'string' || !fs.existsSync(input.transcript_path)) return;
    const n = turnsSince(fs.readFileSync(input.transcript_path, 'utf8'));
    if (n < every) return;
    process.stdout.write(JSON.stringify({ decision: 'block', reason: ask(n, vaultMade(input.cwd)) }));
  } catch { /* exit 0 */ }
}
// ATLAS_SKIP_HOOKS=name,name (or `all`) makes a hook do nothing for one run: for a bench that
// measures one hook without the others, and for finding which hook is behind a problem.
if (require.main === module && !/(?:^|[,\s])(?:all|auto)(?:[,\s]|$)/i.test(process.env.ATLAS_SKIP_HOOKS || '')) { main(); process.exit(0); }
module.exports = { turnsSince, everyOf, ask, MARK, EVERY };
