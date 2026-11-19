# Method — read for every review

## Gather

1. `git diff`, `git diff --staged` and `git status --porcelain --untracked-files=all`. Every
   `??` file is new work no diff shows: it is part of the target and read whole. All three
   empty: `git log --oneline -5` and ask which commit; do not review the last one by guess.
2. For every changed file, read the whole file, not the hunk. Then the callers of what changed
   (`grep` the symbol) and the tests that name it. Half of the findings a reviewer regrets were
   handled one frame up. A caller the diff broke is a finding at the caller, with its fix,
   though the diff never touched that file.
3. Files that must move together: locale files, a header and its implementation, an interface
   and its implementations, a schema and its generated types, a client and its server. When
   one member changed and a sibling did not, the sibling is a `fragile` line naming what it
   lacks. The smaller or the generated member is no reason to skip it.
4. The project's own rules: `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING`, and each
   `.claude/rules/*.md` whose `paths` match a changed file. A rule the diff breaks is a line
   that quotes the rule.
5. Note the languages and frameworks in play; that decides which checklists to read next.

(Untracked files, siblings that move together and path-matched project rules:
alibaba/open-code-review, Apache-2.0.)

## The proof a line needs

A `breaks` or `fragile` line names three things or it is not written:
the input or state that triggers it;
what happens then, wrong value, crash, data lost, request hangs;
why nothing already catches it: the type, the validation upstream, the framework default, the
test. If one of the three is missing, the tier drops to `unclear` or `ask`, or the line goes.

`unclear` names the misreading: what a reader will think the code does, and what it does.
`ask` names the fact only the author has: "is `id` ever negative here?".

The same defect in five places is one line with the count, not five lines. Two different
defects on one line are two lines: an injection and a swallowed `catch` on line 40 are both
written.

Before a line is written, the cited line is read again and must hold the code the finding is
about. Line numbers drift between reading and writing; a line that points at other code sends
the reader to the wrong place, so it is corrected or dropped.

A fix that guards one caller while the shared function keeps the defect is `fragile`, and the
line names the shared function and how many other callers reach it. (DietrichGebert/ponytail,
MIT.)

## What the diff removed

Every output the old code produced and the new code no longer does is chased to its users: a
removed or renamed field, key, status code, default value, message, error type, export, flag
or event. `grep` the old name across the repository, outside the diff. A reader the diff did
not update is a line at that reader: `breaks` when it uses the output unguarded, `fragile`
when it falls back. (alibaba/open-code-review, Apache-2.0.)

Zero findings is a result. A small diff that is typed, tested and shaped like the code around
it gets `nothing found`. Lines invented so the review looks thorough are the main way a model
reviewer loses the reader's trust, and they cost more than a missed nit.

## Never a finding

Style, naming, formatting, import order, quote marks, unless they change what the code does.
Function or file length by itself; length is not complexity. Exhaustive `switch` tables,
configuration objects, test tables and generated code are long on purpose.
"Consider adding error handling" where the caller, a middleware, an error boundary or an
upstream `.catch` already handles it. Trace one caller before writing it.
"Missing validation" on an internal function whose callers validate.
Well-known constants: HTTP codes, 1000 ms, 60, 24, 1024, index 0 or -1, a single-use local
whose name says what it is.
"Prefer const" when the variable is reassigned later in the function.
"Possible null" when the line above narrows it or an `if` guards it; follow the type, do not
pattern-match on `?.`.
"N+1" on a loop of fixed small cardinality or on a path that already batches.
"Missing await" on a call that is detached on purpose: logging, metrics, a queue push, a `void`
prefix or a comment saying so.
Suggesting another language, framework or library than the project's.
Hardcoded values in tests, fixtures and examples; tests are supposed to pin values.
`Math.random`, `eval`, `innerHTML` in a place that is explicitly not security-relevant: an
animation, a plugin loader, a trusted template. Name the risk only when the input can come
from outside.

Before any line, the test: would a senior engineer on this team ask for the change in review?
No: delete the line.

## Tools

`Bash` is for `git diff`, `git show`, `git log`, `gh pr diff`, and for the project's own check
commands when a language file lists them: reading and running checks, never changing files.
A check that fails is one line, the first decisive error quoted exactly, tier `breaks`.

## A dependency changed

One dependency per change, or the lines cannot be told apart. The lockfile diff is read,
not skipped: what else moved, from where. The changelog between the two versions is read
for the parts the project uses; a major bump with the changelog unread is `ask`. A
dependency added for something the standard library or an installed one already does is
`unclear`, with the alternative named.
