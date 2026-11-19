// ATLAS review-full — three review angles in parallel over one diff target, the findings
// merged when they name the same defect on the same line, then every finding handed to a fresh
// agent that did not write it and is told to refute it from the source. Only what survives is
// printed, in the atlas-review line format, with a closing line on files read when the target
// is large or a file went unread. args: { target?: 'git diff HEAD' | 'git diff main...' |
// 'gh pr diff 12' | <file>, prefix?: plugin name before the colon (e.g. 'atlas'), angles?:
// extra angle sentences, rules?: absolute path of the skill's review/ folder }.
// (Untracked files in the target, the read/skipped list, the snippet each finding carries and
// the subjects a refuter may not drop without a guard: alibaba/open-code-review, Apache-2.0.)
export const meta = {
  name: 'atlas-review-full',
  description: 'ATLAS: review one diff from three angles in parallel, then try to refute every finding',
  phases: [{ title: 'Review', detail: 'one reviewer per angle, no shared context' }, { title: 'Refute', detail: 'a fresh agent per finding, source only' }],
}

// no target named means the local work: staged and unstaged both (`git diff` alone misses what
// was already added), and the untracked files, which no diff shows
const named = args && args.target ? String(args.target).trim() : ''
const local = !named || /^git diff( HEAD)?$/.test(named)
const target = local ? 'git diff HEAD' : named
const prefix = args && args.prefix ? String(args.prefix) + ':' : ''
const extra = Array.isArray(args && args.angles) ? args.angles.map(String) : []
const rules = args && args.rules ? String(args.rules).replace(/[\\/]+$/, '') : ''

// subjects where a refuter is often sure and wrong: dropping one needs the guard named
const PROTECTED = ['bounds', 'concurrency', 'declaration', 'default', 'unused-parameter']
const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' }, line: { type: 'integer' },
          tier: { type: 'string', enum: ['breaks', 'fragile', 'unclear', 'ask'] },
          what: { type: 'string' }, fix: { type: 'string' },
          snippet: { type: 'string' },
          subject: { type: 'string', enum: [...PROTECTED, 'other'] },
          verdict: { type: 'string', enum: ['confirmed', 'needs_validation', 'rejected', 'none'] },
        },
        required: ['file', 'line', 'tier', 'what', 'fix', 'snippet', 'subject'],
      },
    },
    changed: { type: 'array', items: { type: 'string' } },
    read: { type: 'array', items: { type: 'string' } },
    skipped: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, reason: { type: 'string' } }, required: ['path', 'reason'] } },
  },
  required: ['findings', 'changed', 'read'],
}
const VERDICT = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean' }, reason: { type: 'string' },
    located: { type: 'boolean' }, line: { type: 'integer' }, guard: { type: 'string' },
    verdict: { type: 'string', enum: ['confirmed', 'needs_validation', 'rejected', 'none'] },
  },
  required: ['refuted', 'reason', 'located'],
}

const ANGLES = [
  { key: 'correctness', ask: 'what breaks on what input: wrong result, crash, data lost, hang. A line names the input that triggers it, what happens, and why nothing already catches it; missing one of the three, drop the tier to unclear or ask.' },
  { key: 'security', ask: 'security: input meeting an interpreter, paths, SSRF, deserialisation, raw HTML; secrets in source, env prefixes, logs; authorisation missing where neighbours have it, IDOR, CSRF; weak crypto; dependencies. Each line carries a verdict: confirmed (path read entry to sink, effect shown by the path read in the source), needs_validation (one fact outside the source decides; name it), rejected (do not report). Never contact anything deployed.' },
  { key: 'errors-tests', ask: 'silent failures: a swallowed catch, an ignored Result or error return, a missing await on a path that matters, a retry that hides a bug; and the tests this change needs but lacks, named by the case they would pin.' },
  ...extra.map((a, i) => ({ key: 'extra' + (i + 1), ask: a })),
]

const untracked = local ? ' Also run `git status --porcelain --untracked-files=all`: every `??` file is new, part of the target, and read whole.' : ''
const ruleFiles = rules ? ` Before reviewing read \`${rules}/method.md\`; when the target touches a CI file (\`.github/workflows/\`, \`.gitlab-ci.yml\`, \`.circleci/\`, \`azure-pipelines.yml\`, \`Jenkinsfile\`), also \`${rules}/ci.md\`.` : ''
const review = (a) => agent(
  `Review this target from ONE angle only: ${a.ask}\nTarget: \`${target}\` (run it with Bash to obtain the diff).${untracked}${ruleFiles} For every changed file read the whole file, not the hunk, then the callers of what changed. A defect the change causes is a finding wherever it lives, in an untouched caller too. Findings only: repo-relative file, line, tier (breaks, fragile, unclear, ask), what breaks and on what input, the fix; \`snippet\`, the code on the cited line copied exactly; \`subject\`: bounds (memory, size, off-by-one), concurrency, declaration (a signature, type or contract its uses no longer match), default (a behaviour or default value the change altered), unused-parameter (accepted and ignored), or other. Two defects on one line are two findings. Also \`changed\`: every file the target changes (\`--name-status\`, plus untracked); \`read\`: those you read whole; \`skipped\`: the others, each with its reason. No style, no praise, no summary. Zero findings is a correct result.`,
  { label: 'review:' + a.key, phase: 'Review', schema: FINDINGS, agentType: prefix ? prefix + 'atlas-diff' : undefined },
)

const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '')
const words = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9_]{4,}/g) || [])
// two angles naming one defect on one line are refuted once; an injection and a swallowed
// catch on the same line are two defects, so file and line alone cannot decide the merge
const sameDefect = (a, b) => {
  if (norm(a.file) !== norm(b.file) || a.line !== b.line || a.tier !== b.tier) return false
  const x = words(a.what), y = words(b.what)
  let common = 0
  for (const w of x) if (y.has(w)) common++
  return common / Math.max(1, new Set([...x, ...y]).size) >= 0.3
}

// the closing line: proof that every changed file was read, needed most on large targets,
// where a reviewer quietly reads a part and reports on the whole
const coverageLine = (rounds) => {
  const changed = new Set(), read = new Set(), why = new Map()
  for (const r of rounds) {
    for (const p of r.changed || []) changed.add(norm(p))
    for (const p of r.read || []) read.add(norm(p))
    for (const s of r.skipped || []) if (s && s.path && !why.has(norm(s.path))) why.set(norm(s.path), s.reason)
  }
  const unread = [...changed].filter((p) => !read.has(p))
  if (changed.size <= 5 && !unread.length) return ''
  const skipped = unread.length ? '; skipped: ' + unread.map((p) => `${p} (${why.get(p) || 'no angle read it'})`).join(', ') : ''
  return `read ${changed.size - unread.length}/${changed.size} files${skipped}`
}

phase('Review')
const rounds = (await parallel(ANGLES.map((a) => () => review(a)))).filter(Boolean)
// barrier on purpose: the same defect reported by two angles is refuted once, not twice
const found = []
for (const r of rounds) for (const f of r.findings || []) if (!found.some((g) => sameDefect(g, f))) found.push(f)
const coverage = coverageLine(rounds)
log(`${found.length} candidate line(s) from ${rounds.length}/${ANGLES.length} angle(s)`)
if (!found.length) return { target, angles: ANGLES.map((a) => a.key), confirmed: [], dropped: 0, coverage, lines: ['nothing found', ...(coverage ? [coverage] : [])] }

const refutePrompt = (f) => {
  const guarded = PROTECTED.includes(f.subject)
    ? `This finding is about ${f.subject}, where a checker is often sure and wrong: refuted=true needs \`guard\`, the file:line of the code that prevents the bug; with no guard to name, refuted=false.`
    : 'Default to refuted=true when the evidence does not hold.'
  return `You did not write this finding. Try to refute it from the repository source only: read \`${f.file}\` around line ${f.line}, the callers of what it names, and the tests. Finding: ${f.tier} — ${f.what}. Proposed fix: ${f.fix}. The cited line should hold this code: \`${f.snippet || ''}\`. \`located\`: whether that code is in the file at all; when it sits on another line, give that line in \`line\`. Refuted means: the input cannot occur, something upstream already catches it, the type or the framework default prevents it, or the effect is not what is claimed. Do not run anything against a deployed system. If the finding is a security one, also give its verdict: confirmed (path and effect hold), needs_validation (one fact outside the source decides; say which), rejected. ${guarded}`
}

phase('Refute')
const judged = await parallel(found.map((f) => () => agent(
  refutePrompt(f),
  { label: 'refute:' + f.file + ':' + f.line, phase: 'Refute', schema: VERDICT },
).then((v) => ({ f, v }))))

const GUARD = /\S+:\d+/
const stands = ({ f, v }) => {
  if (!v) return false
  // the code the finding names is not in the file: the line points at nothing
  if (v.located === false) return false
  if (!v.refuted && v.verdict !== 'rejected') return true
  return PROTECTED.includes(f.subject) && !GUARD.test(v.guard || '')
}
const kept = judged.filter(Boolean).filter(stands).map(({ f, v }) => {
  const line = Number.isInteger(v.line) && v.line > 0 ? v.line : f.line
  const unguarded = v.refuted || v.verdict === 'rejected'
  return { f: { ...f, line }, v, unguarded }
})
const dropped = found.length - kept.length
// a line kept by the veto shows that instead of the verdict, which may read `rejected`
const lines = kept.map(({ f, v, unguarded }) => `${f.file}:${f.line}  ${f.tier}  ${f.what}. ${f.fix}.${unguarded ? '  [kept: no guard named]' : v.verdict && v.verdict !== 'none' ? '  [' + v.verdict + ']' : ''}`)
if (dropped) lines.push(`${dropped} dropped on second look`)
if (!kept.length) lines.unshift('nothing found')
if (coverage) lines.push(coverage)
return { target, angles: ANGLES.map((a) => a.key), confirmed: kept.map((x) => x.f), dropped, coverage, lines }
