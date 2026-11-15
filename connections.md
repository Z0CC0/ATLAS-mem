# Connections for review, fix and commit

None of these is required, and none is installed for you: a command is shown, and you run it.

| tool | what it adds | cost | tried here |
|---|---|---|---|
| a language server, through `atlas-mem` | references resolved by type rather than by text | `typescript-language-server` or `pyright` to install | yes, on JavaScript and Python |
| your CI's logs, through `gh` | `atlas fix` reads the failure as CI saw it | `gh` logged in | not run |

# Connections for atlas-mem

None of these is required, and none is installed for you: a command is shown, and you run it. "Tried" means it was run here, and what the test covered.

| tool | what it adds | advantages | disadvantages | tried here |
|---|---|---|---|---|
| `@huggingface/transformers` | search of the notes by meaning | on 30 questions the right note came first 26 times, against 23 by words alone; stays on your machine | an npm package and a 130 MB model | yes |
| `typescript-language-server`, `pyright` | live references | types and imports resolved: 104 references where the static graph counted 53 callers on one Python symbol | to install, and 20 s on a 200-file project | yes |
| Obsidian or any Markdown editor | reading and editing the vault | the notes are plain files, so nothing is locked in | no check runs in there: run `memcheck` after editing | not as an integration |
| a claude.ai export, through `harvest docs` | past conversations as candidates | only you accept what enters the memory | calls a model, which spends your usage | yes |
