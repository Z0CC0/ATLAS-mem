<p align="center"><img src="assets/banner.svg" alt="ATLAS mem: a memory that notices when it has become false" width="860"></p>
<p align="center"><img src="assets/stats.svg" alt="11 commands, 16 grammars" width="860"></p>

**Most memories for coding agents only grow. This one tells you when a note has stopped being true.** Everything in [`atlas`](https://github.com/Z0CC0/ATLAS), plus review, fix and commit, a memory of notes you keep by hand, a graph of your code across projects, labels that follow a symbol into every search, and a reader of shipped programs.

```
/plugin marketplace add Z0CC0/ATLAS
/plugin install atlas-mem@atlas
```

It ships off, and nothing changes until you type `atlas low` or `atlas high`. Install one ATLAS build: two side by side inject the rules twice. For coding and video too, install [`atlas-max`](https://github.com/Z0CC0/ATLAS-max) instead.

## See it work

You decide a fact is worth keeping, and say so:

```
atlas memory, remember that the retry limit is 3 because the payment API locks the account at 5
```

It writes one note, in your vault's own format, and links it to the code it describes: the repository, the file, the definition, and a fingerprint of those lines. The note and the link stay on your machine.

A month later someone edits that function:

```
atlas memory, is it still true?

retry limit is 3      suspect  changed: retryPayment in src/pay.ts differs from the linked code
session timeout       firm     moved: same code, now at line 212
```

Asked what you decided, it still returns the note, with the warning that the code has changed since. It does not decide for you whether the fact survived. Put the code back, and the note is `firm` at the next check.

The example above is illustrative, with invented names, in the format of the real report. The method is below.

## What it adds

One command, `atlas memory`, in five modes chosen by the words of the request:

| type this | and it |
|---|---|
| `atlas memory, remember that …` | writes one note for one fact, in the vault's own format, and links it to the code it describes when it describes code |
| `atlas memory, what did we decide about …` | finds the right note and returns it whole, saying whether the code it describes has changed since |
| `atlas memory, is it still true?` | checks every note linked to code against the code as it is now and reports: `firm`, or `suspect` with the reason |
| `atlas memory, tidy` | duplicates, orphans, a broken index; nothing deleted without a yes |
| `atlas memory, mark X as superseded by Y` | labels a symbol (CANONICAL, PREFERRED, SUPERSEDED with its successor, WRONG with its reason, FRAGILE, EXPERIMENTAL); a hook then puts the label on every grep or read that finds it |

Nothing is written to memory automatically. A note is created when the work decides a fact
is worth keeping: a decision made, a correction given, a constraint stated. This keeps the
memory small and every note true, which is what makes the check meaningful.

## How a note knows it is stale

The memory is a folder of markdown notes, one fact per file, with a short index. That part
already exists in most setups and is not replaced. The build adds a tool, `tools/memcheck.mjs`,
and a sidecar file beside the notes, `<vault>/.atlas/links.json`, that the tool alone reads and
writes. For a note about code it records which repository, which file, which definition, a
fingerprint of those lines, the commit, and what that code directly depends on in the same
repository. The fingerprint ignores line endings, trailing spaces, blank lines and lines that
hold only a comment in that file's language (`#` in Python, `//` in C and JavaScript, `--` in
SQL; `#define` in C stays code): a comment added inside a function is not a change (measured:
it made a note suspect for nothing). Older fingerprints keep their own recipe and `check --write`
remakes them while the code is intact. At check time the tool parses the file again and decides:

| state | meaning | effect on the note |
|---|---|---|
| held | the lines are exactly what they were | firm |
| moved | the same code at other lines, or in another file | firm; `--write` records where |
| changed | the definition is there, its code is different | suspect |
| dep-changed | the code is intact, but a function it calls or a constant it reads changed | suspect |
| renamed | the same body under another name | suspect; the report says the new name |
| gone / missing | the symbol, or its file, is nowhere in the repository | suspect |

A `suspect` note is still returned when asked for, with the caveat; nothing decides for you
whether the fact survived the change. A note whose code is put back as it was returns to
`firm` at the next check by itself. The body of a note is never changed by a check.

Parsing uses tree-sitter grammars compiled to WebAssembly, shipped in `tools/wasm/` (22 MB,
MIT, from the `@vscode/tree-sitter-wasm` package): JavaScript, TypeScript, TSX, Python, Go,
Rust, Java, C#, C/C++, Ruby, PHP, Bash, PowerShell. Any other language falls back to a search
for a definition-shaped line, with the limits stated in the skill.

## The code graph

`tools/codegraph.mjs` is the second tool: the graph of the code across every project under
one folder. `node codegraph.mjs scan <root> --out graph.json` parses every source file once
and records files and imports, top-level symbols and calls inside each project, duplicates
(identical text, or the same shape with other names: a renamed copy) inside and across
projects, and uncalled symbols graded certain / probable / uncertain from the list of what a
static graph cannot see. `report`, `dups [--cross]`, `hubs [project]`, `dead [project]`
read the JSON back. Projects declared as a porting of one another (`--porting "A|B"`) keep
their duplicates marked and out of the counts. Measured on twelve projects: 665 files,
208,000 lines, 12,500 symbols in 20 seconds. It never changes a source file.

## Labels: code is never deleted, it is marked

`tools/labels.mjs` keeps a small table of verdicts on symbols, `<vault>/.atlas/labels.json`:
CANONICAL (the reference version across projects), PREFERRED, SUPERSEDED (needs its
successor: a superseded symbol without one is refused), WRONG (with the reason, which is the
value), FRAGILE, EXPERIMENTAL. Every label needs its reason. `set`, `unset`, `list`,
`lookup`. The part that makes it work is the hook `hooks/atlas-labels.js`, on `PostToolUse`
for `Grep` and `Read`: when a result names a labelled symbol, the label is attached to the
result as context, one line per symbol, with the successor and the reason. Nothing is
hidden or changed; the old code just cannot be found bare. With no vault it is silent. The file is 4 KB; what a hook prints is kept under the 10 KB that Claude Code
hands the model whole.

A second hook, `hooks/atlas-precompact.js`, runs on `PreCompact`: before Claude Code
compacts a conversation, the lines of this session that read like a decision, a rule, a
preference or a correction are pulled out of the transcript, the same way `harvest extract`
reads past sessions, and written to `<vault>/.atlas/harvest/<session>.md`. Compaction keeps a
summary and drops the words; this keeps the words that matter. Nothing enters the vault: the
file is raw material, and `harvest run <vault>/.atlas/harvest <out> <vault>` turns it into
candidates for the inbox, each still needing a yes. A session that compacts twice replaces
its file. No vault, no transcript, or nothing decision-shaped beyond the first request: it
writes nothing. It never blocks the compaction (always exit 0, 10 s timeout). The same file
runs on `SessionStart` with the `compact` matcher, when the conversation resumes on its
summary: the lines kept for this session come back as additional context, under 6 KB, so a
rule stated before the compaction is still in front of the model after it. Compaction keeps
the gist; this keeps the rules.

A third hook, `hooks/atlas-signals.js`, runs on `Stop`, when an answer ends. It reads the
session transcript for one sign that a note is due: a check that failed and passed after an
edit, a correction followed by code work, a git undo with no commit after it, an option picked.
When it finds one it blocks the stop with a single question, which costs one more turn: write
one note through the usual gate, or say in one line that nothing is worth keeping. At most
three questions a session, each sign asked about once, the undo sign once a session; it writes
nothing itself. Silent with no vault, and while Claude Code is already answering a stop hook.
To switch it off: `"signals": false` in `~/.claude/atlas.json`.

### Where the vault is, and who may choose it

The three hooks and `tools/labels.mjs` find the vault with one rule, `hooks/atlas-vault.js`:

1. the nearest `.atlas.json` at or above the working directory with `"vault": "<path>"`, but
   only when `~/.claude/atlas.json` confirms that same path, as its `"vault"` or in its
   `"vaults"` list;
2. otherwise the `"vault"` of `~/.claude/atlas.json`;
3. otherwise the Claude Code memory folder of the working directory, when it exists.

The confirmation is there because a `.atlas.json` arrives with whatever repository was cloned:
taken as it was, a repository could decide where the pre-compaction hook writes the lines of
your sessions, inside itself ready to be committed, or in a shared folder. An unconfirmed one is
skipped as if absent; `node tools/labels.mjs vault` names it and says what to add.

```json
{ "vault": "C:/notes/vault", "vaults": ["C:/work/app/docs/memory"], "signals": false }
```

`~/.claude` is `$CLAUDE_CONFIG_DIR` when that is set: the hooks, the tools and the `atlas guard`
switch read and write the same file.

## Harvest: filling the memory from what already exists

`tools/harvest.mjs` is the third tool. `harvest extract <claude-projects> --out <dir>` reads
every past Claude Code session (one JSONL each; benchmark and scratch folders skipped, tiny
sessions skipped) and keeps, per session, the first request, the user's messages that read
like a decision, a rule or a correction, and the assistant's paragraphs that state one: a
few kilobytes per session instead of megabytes. `harvest docs <root> --out <dir>` collects
the projects' markdown documents. `harvest claude <conversations.json> <out-dir>` does the same for a claude.ai data export
(Settings → Privacy → Export data). `harvest run <extract-dir> <out-dir> <vault> [--write]` has a model turn each extract into
candidates (the prompt is `tools/harvest-prompt.md`; the vault's existing notes are listed in
it so they are not restated), and `harvest judge <vault>` has it say, for every pair of
notes that share enough words, whether they are the same thing, a contradiction, or neither
(`tools/pairs-prompt.md`). Both call Claude Code headless and lean: no MCP servers, no
skills, no plugins, our own system prompt, so a call carries about 7,000 tokens instead of
the 52,000 a bare `claude -p` loads from the session, and the prompt prefix is shared across
the run and cached. `--dry` says what would be sent and sends nothing; `judge --redo` asks
again about pairs already judged (after a change to the prompt). Measured: 9 pairs for $0.39,
three of them the same rule written twice; `harvest inbox write <vault> <candidates.json>` files them in
`<vault>/.atlas/inbox/`, skipping what the vault or the inbox already says in other words.
`inbox list`, `inbox accept <slug>` (the file becomes a note, one line goes into the index)
and `inbox reject <slug>` (removed, and its source hash remembered so it never comes back).
`harvest suggest <vault>` has a model read every candidate against the vault's index and
propose accept, merge (into which note) or reject, with the reason, into
`<vault>/.atlas/inbox-suggestions.json`; the inbox page and the app show the proposal beside
each candidate and can take all of them as decisions in one click. A proposal is not a
decision: nothing moves until the person says so. To review a large inbox away from any app, `tools/inbox-page.mjs <vault> <out.html>` writes
one HTML page with every candidate grouped by source, Accept / Reject buttons that work
offline, and a "Save decisions" button that downloads a JSON; `harvest inbox apply <vault>
<decisions.json>` then accepts and rejects for real. Nothing enters the vault without that yes. Measured on this machine: 39 real sessions and 67
documents extracted in under two seconds; the model pass at about 0.1 $ per source.

Three more things, all deterministic: `codegraph` records what a class extends or
implements (`inherits` edges) and answers `impact <graph> <project> <symbol> [--depth 2]`
with the blast radius, what calls or inherits from a symbol and then what calls those;
`memcheck check --write` records for every note which other notes touch the same code
(`related`: same symbol, a shared dependency, the same file), the link the code implies
without touching a wikilink; `harvest pairs <vault>` lists the notes that share enough words
to be read side by side, and `harvest verdicts write|list` keeps what a model or a person
decided about each pair (the same thing, a contradiction, neither). The prompt for that
judgement is `tools/pairs-prompt.md`.

## Two optional layers

`tools/embed.mjs`: search by meaning. `embed index <vault>` turns every note (name,
description, body, `<private>` spans removed) into a vector with a small multilingual model
that runs on this machine, re-embedding only what changed; `embed search <vault> "<query>"`
returns the nearest notes with a score; `embed status`. Each note has two vectors, the whole
note and its name with description alone, and the better of the two counts: a question is
short and about one thing, and against a long body the signal drowned (on 30 questions the
body alone put the right note first 11 times, the pair 21). `--words` adds the words: the
question's words (five letters or more, matched on their stem) are counted on each note, name
and description twice, and the two rankings are fused by reciprocal rank; on the same 30
questions the right note came first 26 times (21 by meaning alone, 23 by words alone), and
in the first three 27. The model
(`Xenova/paraphrase-multilingual-MiniLM-L12-v2`, about 130 MB) is downloaded once into
`~/.atlas/models` (or `ATLAS_MODELS`); nothing leaves the machine. Measured: 67 notes
indexed in 8 seconds; a query in well under a second. Needs `@huggingface/transformers`.

`tools/lsp.mjs`: live references. `lsp refs <project-root> <file> <line> <symbol>` starts
`typescript-language-server` or `pyright-langserver` through this same Node, opens the file
and asks who references the definition: types and imports resolved, the code as it is now.
Measured: a JavaScript symbol in 0.5 s; a Python symbol in a 200-file project in 20 s, with
104 references where the static graph counted 53 callers. `lsp check` says which servers
this machine has. Needs `typescript-language-server` (with `typescript`) and/or `pyright`.

Both packages are looked for next to the tools, then in `ATLAS_NODE_MODULES`, then in the
global npm folder; `npm install @huggingface/transformers typescript-language-server
typescript pyright` in any of those places is enough. Without them, everything else works
and the tools say what is missing.

## What it costs

| | `atlas` | `atlas-mem` |
|---|---|---|
| names and descriptions, counted, in every session | 824 | 1,691 |
| rules injected at `low`, counted | 1,408 | 1,410 |
| installed and switched off, as billed | 1,238 | 2,569 |
| first turn at `low`, as billed | 3,356 | 4,690 |
| first turn at `high`, as billed | 3,536 | 4,873 |
| a 40-turn session at `low`, against no plugin | -18% | -12% |
| a 295-turn session at `low` | -33% | -32% |
| a 40-turn session at `high` | -27% | -20% |
| a 295-turn session at `high` | -42% | -41% |

Billed on `claude-opus-5-5` at 0.1.0. The session rows assume this build saves per answer what `atlas` saves; that was not measured on this build. The six files behind `atlas memory` are 6,820 tokens, read when the command is used. The stale-note check is local and takes under a second on a vault of a dozen linked notes; its output is a few lines. Loading all sixteen grammars takes about 90 ms.

## Advantages of this build

- A note that describes code is flagged as suspect when that code changes, instead of staying true by assumption.
- A code graph across projects, labels that follow a symbol into every grep and read, and a harvest of past sessions into an inbox only you accept from.
- `atlas-artifact` reads a shipped program, a binary or a database without running it.
- Review, fix and commit come with it, so you do not need `atlas-code` beside it.

## Disadvantages of this build

- 1,331 more tokens than `atlas` in every chat, and a 23 MB download, of which 22 MB are grammars.
- Three more hooks. `atlas-signals` can ask for a note up to three times a session, one turn each; `"signals": false` in your user `atlas.json` switches it off.
- Notes are written by hand. A memory you do not feed stays empty.
- Search by meaning and live references need npm packages and a 130 MB model. Everything else works without them.
- `harvest` calls a model when you run it, and that spends your usage.
- A vault named by a project counts only if your user `atlas.json` confirms it: add it to `vaults`.

## What was tried

The six tools have 100 tests (`node --test tests/*.test.mjs`; the live ones skip when their
package is missing).


Two benches on real material. Freshness: ten notes linked to ten
functions of a 57-file Python project (a copy); five bodies changed, one function renamed,
one deleted, one given a comment, one pushed down by lines added above it, one untouched. The
check said suspect for exactly the seven that deserved it and firm for the three that did not;
before the comment rule, the comment alone made an eighth note suspect. Recall: thirty
questions written in other words than the notes, each with the note that answers it. By words
against the index, the right note came first 24 times and in the first three 27; by meaning,
21 and 24; one of the two ways had it in the first three 27 times out of 30. The three misses
are notes whose index line does not name the thing asked about (a 503 from the data provider,
the size limit of the hooks, the command to run after a change). The command was run as a skill in two real
sessions on a copy of a vault: a check that found a stale note and put the question in one
line, and a write that produced a correct note with two code links taken from the parse. Both
cost between one and two dollars at the CLI's default model, most of it reading notes.

Not seen, by design or not yet: a change in a library the code uses; a method reached through
an object (`obj.method()`); a change two calls away; a symbol renamed and rewritten in the
same step (reads as `gone`). Whether the application that manages the vault ignores the
`.atlas` folder beside the notes was not verified against every such application.

## Limits

The vault is yours and stays in your format; the tool never edits a note. A note linked to
code that is not on this machine is reported as not checked, never as broken. Nothing leaves
the machine.

## Inside a shipped artifact: `atlas-artifact`

`tools/artifact.mjs` reads an installed program the way a person would open the box: the
`.asar` (or the folder under `resources/`) as bytes, every module outside `node_modules`
parsed into a syntax tree with the grammars in `tools/wasm/` (`tools/artifact-js.mjs`),
and reports what the entry reaches, the IPC channels in both directions with their pairing
(a channel sent and never handled, a channel pushed and never listened for), the
`contextBridge` keys, every `BrowserWindow` with its preload and the preferences that
matter, the hosts in URL literals, the processes it starts by name, the system APIs it
touches, `eval`, the secret-shaped environment variables it reads, the native addons. A channel
held in a constant, an object of channels, a template, a compiled enum or another file of
the archive is resolved and marked `derived`; a wrapper the app wrote around
`ipcMain.handle`, `ipcRenderer.invoke` or `webContents.send` is recognised from its body
and its callers counted (`derived` for a plain call, `inferred` through an object). A webpack build
is read by its module table (modules with their extent, edges from the module's own
require calls), an esbuild build by its named modules, and every fact inside a bundle
carries its module; when the archive ships the map, the original file, line and column
too. `fuses` reads the build-time switches of the Electron executable after their sentinel
(eight by name, later ones by index) and lists the ones a shipped application is not
expected to have. `compare` reads two versions and lists what changed by name. `observe`, only
with `--yes` from the person and on their own program, starts it with its debugging ports
open, reads the main process (the IPC channels really registered, the windows with the
preferences they got, the child processes, paths and versions) and every renderer (network
requests by host, console, exceptions, the bridge keys and what they expose), stops it by
process id after the seconds asked, and correlates with the static reading: channels and
hosts that only one side sees. It refuses when the program is already running, since the
running instance is not its to stop. `bin` reads a
compiled file by the tables its loader reads: a PE (machine, sections and their
permissions, imports by DLL, exports, version resource, manifest, ASLR/NX/CFG/signature,
and when a CLR header is there the .NET metadata: assembly, references, types, methods,
every P/Invoke, user strings, entry), an ELF (needed libraries, rpath, symbols, PIE, NX,
RELRO, canary, stripped), a Mach-O (thin or fat, dylibs, platform and SDK, rpaths,
signature, symbols), and in any of them the Go build information (version, modules,
settings) and the Rust compiler and crates the panic paths keep. For a .NET assembly, `cil` goes further and disassembles the method bodies: the CIL of
each method as a named instruction listing (the opcode table from ECMA-335), with call,
field and `newobj` tokens resolved to `Type::member` and `ldstr` strings shown; it reports
how many bodies decoded fully and any unknown opcode (42,949 methods across five real
assemblies, 100%, none unknown). `disasm` decodes the x86-64 instructions of a program's code sections (opcode maps,
prefixes, ModR/M and SIB from the Intel SDM, so instruction length is exact), from the
entry point by default, with a coverage number from a linear sweep (over 99% decoded on a
C++, a Go and an ELF binary; the classic prologue and stack-canary read back correctly).
The ARM64 (A64) decoder is fixed-width (every instruction 4 bytes, from the Arm ARM, no
length to get wrong): on a real arm64 binary, 100% allocated, the prologue and GOT-load
patterns read back correctly. `disasm` picks the decoder from the architecture. `dex` reads an Android `.apk` (a ZIP, its `classes*.dex` pulled out) or a bare `.dex`:
the pools from the DEX format spec, then each method's Dalvik bytecode decoded with every
index resolved to a name (`invoke-direct {v1, v2}, Type;.method`, `const-string "…"`). On
the Android API compiled to Dalvik (6,376 classes), 55,481 method bodies, 100%, no unknown
opcode. `cfg` recovers one function's control-flow graph from the disassembly (basic blocks, the
direct edges, loops from back-edges) on x86-64 and arm64 — the skeleton before expressions
and structuring. A PE's import address table is read, so a `call [rip+x]` to an import shows its
`dll!function` in `disasm`, `cfg` and the pseudo-C (`rax = KERNEL32.MultiByteToWideChar(...)`).
`cfg --pseudo` lifts the CFG to structured pseudo-C — x86-64 and ARM64 (A64), both with the full middle-end (liveness, dead-store elimination, stack-frame recovery, API-anchored types, points-to struct recovery). On x86-64: intra-block expression folding
(`eax = (-(ebp | 0xff))`), branch conditions recovered from `cmp`/`test` + the jump, memory
as `*(addr)`, registers as the variables; then structured over the dominator and post-
dominator trees into `if/else` and `while`/`for (;;)` with `break`/`continue`, a labelled
`goto` only where the flow is irreducible (`--goto` keeps the flat listing). Types are
recovered where anchored: a resolved import call is ground truth, so a compact table of
Win32 / C-runtime / ntdll prototypes types the argument registers (rcx/rdx/r8/r9) and the
return (rax), annotated in place (`rax = (ULONG)ADVAPI32.EventRegister(/* LPCGUID, … */)`),
with sign carried from signed vs unsigned jumps; an unanchored type stays `?`. The stack
frame is then recovered: each slot becomes a named local (`*(rsp+0x30)` → `local_30`), and
the compiler boilerplate (stack canary, frame set-up/tear-down) is annotated. A backward
liveness pass over the CFG drops the dead register writes at block ends (a value used only in
an address is substituted in), and a value is forwarded into the block that uses it along a
linear chain (never across a branch, so it can't be duplicated); `xor r, r` reads as `r = 0`.
Memory access reads as array and field access from the address shape (`[base+i*8]` → `base[i]`, `[base+0x10]` → `base->field_10`). The register state is width-canonical (writing `eax` kills and zero-extends `rax`, `inc rax` is seen by a later `eax` read), so a value that merges from two paths is handled correctly through the register variable. A dead-store elimination pass removes the spills every reader inlined (register names canonicalised, call right-hand sides kept). An intra-procedural points-to pass groups field accesses by object (origin tag: `arg0`..`arg3`, a call return, a global, or `arg0.f0` for a pointer loaded from a field), so accesses through different registers to the same object merge into one `struct arg0_t` and two different arguments stay separate; it falls back to per-register when no object can be tagged. Each field is a pointer if its value is dereferenced (or a `void (*)()` if called), else an integer whose width is the access size (`mov eax, [rcx+0x24]` → 32-bit); arrays are typed from the index scale. Full inter-procedural type inference and real member names remain the frontier.
`dex --pseudo` lifts each Dalvik method to pseudo-Java (register forward substitution, `new Type(args)` from new-instance + `<init>`, calls folded through `move-result`), with the gotos structured into `if/else`/`while` (`--goto` for the flat form): the android.jar stub reads back as `throw new RuntimeException("Stub!");`.
`wasm` reads a WebAssembly module per the W3C core spec: sections, signatures, imports/exports, and each function's code; `wasm --pseudo` lifts the stack machine back to structured pseudocode (block/loop/if become real control flow, loads/stores become `mem[addr]`, calls use the export/import name), e.g. a function reads back as `return (local0 + local1);`.
`evm` reads Ethereum Virtual Machine bytecode (raw or hex) per the EVM opcode list: disassembly with JUMPDEST labels, the 4-byte function selectors from the dispatcher, and the Solidity metadata (solc version, IPFS hash); `evm --pseudo` lifts the stack to pseudo-Solidity (`storage[k]`, `msg.sender`, `calldata[x]`, constant jumps resolved), structured into `if/else`/`while` (`--goto` for the flat form).
`pcap` reads a libpcap or pcapng capture: link type, then Ethernet/IPv4/IPv6/TCP/UDP/ICMP decode, with protocol counts and the conversations (who talked to whom, on which ports) ordered by packet count.
`sqlite` reads a database file read-only: schema, counts, indexes, triggers, a sample of
one table on request. `cil --pseudo` lifts a .NET method's CIL to readable pseudo-C# by simulating the stack (call arity read from the signature): e.g. `throw new ArgumentNullException(GetArgumentName(arg0));`; 7,176 core-library methods lift with no crash, and the labelled gotos are structured into `if/else`/`while` (`--goto` keeps the flat listing). `map` decodes a source map and turns a bundled position back into a file,
line and name.

Every answer is one record: an id derived from the record, the subject with its sha256,
the operation, a confidence (`observed` from the bytes, `derived` from observed facts,
`inferred` when the reading could be wrong), the coverage in words, the limitations. The
reading is textual and says so: a channel built from a variable or a URL assembled at run
time is an `unknown` in the report, not a missing fact. `--text` prints twenty readable
lines; the JSON is read by page. Nothing is executed, nothing is written, no network.
Binaries (`.exe`, ELF, Mach-O, APK, firmware) are recognised by `detect` and not read.

Measured on five installed applications (2026-10-18), text patterns against the parse:
the author's own app (180 MB, 7,790 files) 0.9 s, 60 handlers of which 49 through its
wrapper, 67 channels, every renderer call paired; a bundled app with Electron on a
namespace: 0 → 3 handlers; an app whose channels are a compiled enum: 0 → 8 handlers, 12 →
3 unknown; one app with channels built from `this` fields at run time: 23 unknown, stated
as such. The same five, read as bundles: one webpack build of four files with 601, 142,
100 and 13 modules and 2,249 edges in all; one esbuild-style build shipping its map, every
finding mapped to its original file and line; fuses read from all four executables, with
four to six switches in the weak state on each. Compiled files, same day: an Electron
executable (233 MB, 0.9 s: 7 DLLs, 3,241 exports, ASLR, CFG, unsigned), a .NET core
library (14.6 MB, 0.2 s: 2,755 types, 39,326 methods, 550 P/Invoke), a Go tool (12 MB,
0.2 s: go1.25.1, 22 modules, VCS revision), a Linux `.node` addon (needed libraries,
runpath, canary) and its macOS twin (dylibs, SDK, signed). Alive: the author's own app for fifteen
seconds, main process and one page reached, four channels at runtime against three in the
code (the fourth is the event emitter's own `error`), the bridge with its forty-two keys,
the window with the preferences the code promised, stopped by process id.

## How it compares

`atlas-mem` was designed after reading these. Its code and its text are its own, and what was taken is named. The one idea here that we did not find elsewhere is the note tied to a fingerprint of its code. On almost everything else, someone is ahead.

Figures from 2026-11-02. "Not found" comes from a search of each project, not a proof of absence, and claude-mem and codebase-memory-mcp were read through their README and code search only, because of their size.

| project | stars | how it works | what we took | automatic? | what leaves your machine |
|---|---|---|---|---|---|
| **`atlas-mem`** | | notes by hand, tree-sitter, hooks | | no: you decide what is kept | nothing, except `harvest`, which calls a model when you run it |
| [Trail-Code](https://github.com/trailhq/Trail-Code), MIT | 11,032 | CLI, hooks, MCP | the note gate and the signs a note is due | yes, at every prompt | telemetry on by default, opt-out |
| [claude-mem](https://github.com/thedotmack/claude-mem), Apache-2.0 | 110,571 | worker service, SQLite, Chroma, MCP | read, nothing taken | yes, every tool use | observations go to a model of your choice; telemetry on by default, opt-out |
| [Serena](https://github.com/oraios/serena), GPL-3.0 and MIT | 31,018 | MCP, language servers | read, nothing taken | no | nothing found |
| [Graphify](https://github.com/Graphify-Labs/graphify), Apache-2.0 | 141,061 | Python CLI, tree-sitter, a hook | read, nothing taken | rebuilds on commit | docs and images go to your model |
| [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp), MIT | 48,002 | C binary, MCP, daemon | read, nothing taken | re-indexes | nothing, by its own statement |
| [claude-reflect](https://github.com/BayramAnnakov/claude-reflect), MIT | 1,916 | Python, four hooks | the pattern that spots a correction | catches corrections live | the model calls you make |

**Where `atlas-mem` is better**

- **A note that knows it is stale.** Six states, from `held` to `gone`, and a check that also follows what the code depends on. In Trail-Code a note can name a file, and we found no fingerprint or suspect state; the same search found nothing in Serena, Graphify, claude-reflect or the README of codebase-memory-mcp. For claude-mem the search was weaker.
- **Nothing enters without a yes.** A small memory you trust, not a large one to search.
- **A reader of shipped programs,** `atlas-artifact`: an Electron app, a binary, a database. We found no match in the others.
- **No telemetry, and no service to run.**

**Where they are better**

- **Doing it for you.** claude-mem and Trail-Code capture and bring back context with no effort from you. Here, a memory you do not feed stays empty. Many people will rightly prefer theirs.
- **Scale and reach.** codebase-memory-mcp indexes 162 languages, and the Linux kernel in 3 minutes. Ours has 16 grammars, and its largest measured run is 208,000 lines in 20 seconds. Serena has 40+ languages and edits code by symbol, which we never do.
- **Teams.** Trail-Code shares learnings through git and warns when a teammate changes the same symbol. `atlas-mem` is for one person.
- **Beyond code.** Graphify puts docs, PDFs, images and video in its graph, with communities and a browsable page.
- **Other hosts.** All of them reach more agents. `atlas-mem` is Claude Code only.

**A note on their benchmarks.** Trail-Code publishes 32% lower cost on 162 runs, and Graphify 45.3% on LOCOMO. We could not find in those repositories the harness that reproduces them, so we neither repeat them as fact nor dismiss them. We have run no benchmark of `atlas-mem` against any of these.

## Connections

Tools you can attach, each with its advantages and disadvantages, and whether it was tried here: [`connections.md`](connections.md). Nothing is installed for you.

---

Part of [ATLAS](https://github.com/Z0CC0/ATLAS), which holds the bench behind every figure here. MIT licence. The grammars are MIT, from `@vscode/tree-sitter-wasm`.
