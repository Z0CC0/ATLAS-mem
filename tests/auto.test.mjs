// atlas-auto: off until asked, then one more turn every few turns. The count is tested on crafted
// transcripts, the hook end to end through stdin, the switch through memcheck.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const hook = path.join(here, '..', 'hooks', 'atlas-auto.js');
const tool = path.join(here, '..', 'tools', 'memcheck.mjs');
const { turnsSince, everyOf, MARK } = createRequire(import.meta.url)(hook);

const user = (content, extra = {}) => JSON.stringify({ type: 'user', message: { content }, ...extra });
const said = (n) => Array.from({ length: n }, (_, i) => user(`turn ${i}`)).join('\n');

function setup(config) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-auto-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  if (config) fs.writeFileSync(path.join(home, '.claude', 'atlas.json'), JSON.stringify(config));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CLAUDE_CONFIG_DIR;
  return { home, env };
}

function fire(s, transcript, extra = {}) {
  const file = path.join(s.home, 't.jsonl');
  fs.writeFileSync(file, transcript);
  const cwd = path.join(s.home, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  return spawnSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: file, cwd, ...extra }), encoding: 'utf8', env: s.env }).stdout;
}

test('only what the person typed counts, from the last write on', () => {
  assert.equal(turnsSince(said(3)), 3);
  assert.equal(turnsSince([user('hi'), user([{ type: 'tool_result', content: 'x' }]), user('<command-name>x'), user('meta', { isMeta: true }), user('ok')].join('\n')), 2);
  assert.equal(turnsSince([said(4), user(`Stop hook feedback: ${MARK} write`), user('next')].join('\n')), 1);
});

test('the setting reads as off, the default, or a number', () => {
  assert.equal(everyOf(undefined), 0);
  assert.equal(everyOf(false), 0);
  assert.equal(everyOf(true), 5);
  assert.equal(everyOf(1), 1);
  assert.equal(everyOf('often'), 0);
});

test('off by default: nothing, however many turns', () => {
  assert.equal(fire(setup(), said(50)), '');
});

test('on: nothing before its turn, then one more turn and a note marked as automatic', () => {
  const s = setup({ memoryAuto: 3 });
  assert.equal(fire(s, said(2)), '');
  const out = JSON.parse(fire(s, said(3)));
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /source: auto/);
  assert.match(out.reason, /Never the value of a secret/);
  assert.ok(fs.existsSync(path.join(s.home, '.claude', 'projects')), 'the vault is made when there is none');
});

test('never loops: silent while the hook itself is active', () => {
  assert.equal(fire(setup({ memoryAuto: 1 }), said(5), { stop_hook_active: true }), '');
});

test('memcheck switches it on and off, and keeps the rest of the file', () => {
  const s = setup({ guard: true });
  const file = path.join(s.home, '.claude', 'atlas.json');
  const run = (...a) => spawnSync(process.execPath, [tool, 'auto', ...a], { encoding: 'utf8', env: s.env });
  assert.match(run('on').stdout, /on, every 5 turns/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { guard: true, memoryAuto: 5 });
  assert.match(run('on', '--every', '1').stdout, /every 1 turn/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).memoryAuto, 1);
  assert.match(run('status').stdout, /on, every 1 turn/);
  assert.match(run('off').stdout, /off/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { guard: true });
  assert.notEqual(run('sideways').status, 0);
});
