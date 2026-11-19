# The whole repository — when the request is an audit of the codebase, not of a diff

A diff review reads what changed; an audit has no diff, so it reads a map first and the code
second. Security has its own audit in atlas-secure and dead code in atlas-refactor; this file
is for everything else the line format covers.

## Map first

Before any finding, three things in at most five lines: the entry points (main, routes,
handlers, jobs, CLI commands), the two or three data flows that carry most of the work, and
the expected load as `scale.md` reads it. The map decides what is read; files off every flow
are read last or not at all.

## Reading

The reading goes to the `atlas-diff` subagent, target the paths of one flow at a time, so the
files stay out of this conversation. Each flow is read with `method.md` and the language
files, as for a diff. Without subagents: one flow here, and say how many were left.

## The report

At most 20 lines in the ordinary line format, ordered by tier. The same defect in many files
is one line with the count. Then two lines: `fix first: <the 1 to 3 lines that matter most>`,
and `not read: <the parts of the repository left out, with why>`. Nothing found on a flow
that was read is not a line; a flow that was not read is named.

(The map-first audit: DietrichGebert/ponytail, MIT.)
