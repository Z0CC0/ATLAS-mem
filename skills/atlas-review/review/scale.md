# Load — for diffs that touch a job, queue, worker, cache or global, and before a merge

Code can be right for one user and wrong with two workers. The load decides which of the two
the review judges, so it is read before any line here.

## The load first

Read it from the README, the deploy config (replica or worker count, `WEB_CONCURRENCY`, a
`Procfile`, the process manager, a serverless config) and the size of the tables or files the
code walks. Say it in one line before the findings: `load: <requests or users>, <workers>,
<data size>`. Nothing says: `load: unknown, judged at 2 workers and 10x today's data`, and
every line below names the number it assumed.

## Four shapes

A check followed by a write that depends on it, with nothing holding the row in between: no
lock, no unique constraint, no transaction at the right isolation, no compare-and-set. Two
requests both pass the check. `breaks` when the stated load runs it twice at once.
State kept in one process that the others need: an in-memory cache, a rate-limit counter, a
session map, a lock object, a scheduled job that every replica starts. With 2 workers each
one sees half. `breaks` when the deploy runs more than one process.
A list, map, cache or listener set that only grows: no bound, no eviction, no expiry, a
handler added per request. The line names what it holds after a day at the stated load.
One query or remote call per item, in a loop whose length grows with the data. The line names
the item count at the stated load and the batch call that replaces the loop.

A shape that holds at the stated load and breaks only above it is `fragile`, with the number.
SQL locking and indexes are in `database.md`; this file is for the rest. The "N+1" and
fixed-cardinality exceptions in `method.md` still hold.

(The load lens and its four shapes: DietrichGebert/ponytail, MIT.)
