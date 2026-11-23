<div align="center">
   <img src="docs/screenshots/icon-256.png" alt="ToffeeTwirl IDE" width="128"/>
   <h1>ToffeeTwirl IDE</h1>
   <h3>The IDE of <a href="https://github.com/itsHarshDabas/GraceOS">GraceOS</a></h3>
</div>

ToffeeTwirl is VS Code, built from Microsoft's MIT-licensed source with [VSCodium](https://github.com/VSCodium/vscodium)'s scripts and patches, then given GraceOS's name, look and local AI:

- **Command:** `twirl` (`twirl .` opens a folder). Its settings live in `~/.config/ToffeeTwirl`, and its extensions in `~/.toffeetwirl/extensions`.
- **No telemetry,** as in VSCodium. Extensions come from [Open VSX](https://open-vsx.org).
- **Grace look:** the built-in Grace Dark and Grace Light themes, from the GraceOS design tokens. It follows the system's dark or light style, so GraceOS's Dark Style switch flips it. Fira Code is the editor font.
- **Grace, the local AI** (the built-in `grace` extension):
   - **Grace Agents**, an agent-first workflow: Grace plans, makes folders and files, edits code and runs checks in your project, in Plan, Build or Auto (headless) mode. See [Grace Agents](#grace-agents).
   - "Grace: Explain Selection" (also in the editor's right-click menu), "Grace: Ask About This File…" and "Grace: Ask…".
   - They run only [CherryCola](https://github.com/itsHarshDabas/CherryCola) on this computer (`cherrycola ask -`, with Ollama, llama.cpp or LM Studio). Answers stream into the "Grace" output and can be cancelled.
   - If the model isn't downloaded, "Download the model" runs `cherrycola pull` in a terminal.
   - With AI off in GraceOS Settings → AI & Models (`ai = off` in `~/.config/grace/desktop.conf`), every Grace command, menu item and the status bar item disappear, live. Everything else in the IDE works the same.
- Only Linux x64 is built. VSCodium's macOS, Windows and other Linux builds, and its update service, aren't part of ToffeeTwirl; on GraceOS, pacman updates it.

## Grace Agents
ToffeeTwirl is agent-first: it opens on the **Agent Home** (Ctrl+Alt+G, or the ✦ Grace item in the status bar) when no files are open, and the **Grace Agents** side bar (the ✦ icon in the activity bar) keeps your tasks next to the code. You say what to build; Grace plans it, makes the folders and files, edits the code, runs the checks, and wraps up with what changed. Everything runs on this computer with the model CherryCola serves.

![The Agent Home with a Build task waiting for review](docs/screenshots/agent-build-review.png)

**Modes** (pick one per task):
- **Plan:** Grace reads the project and writes a plan as a checklist. Nothing changes until you approve it. You can edit the steps, send it back with a note, or approve it, with or without reviewing each change after that.
- **Build:** Grace plans and builds. Each new folder, file change and command waits for you, with a diff: Accept, Reject (with a note Grace reads), "Review in editor" (the side-by-side diff) or "Accept all for this task".
- **Auto (headless):** Grace plans and builds on its own while you do something else, and a notification says when it's done. Commands run only if they are on the allow list (`grace.agent.autoCommands`: `npm test`, `pytest*`, `cargo test*`, …); anything else is skipped and listed in the wrap-up with a "Run in terminal" button.

**What a task may do** (switches on each task): *Make folders & files*, *Edit files*, *Run commands*, and *Include the open file* (the file or selection goes along as data).

**While it works:** the plan stays on top with its progress, every step shows in the timeline (files read, searches, diffs, command output), and you can type into the task at any time to steer it. Tasks queue: several can be open, and Grace runs one model turn at a time. They're kept per folder, so they're still there after a restart; Continue picks a stopped one up again.

**When it's done:** the wrap-up lists every changed file (click for its diff) and its line counts, and **Undo all changes** puts every file and folder back. A file you edited yourself since is left alone.

**New project:** with no folder open, "New project…" makes a folder, opens it, and starts the task there.

**Templates:** Scaffold a project, Write tests, Fix what fails, Map this codebase.

| Plan review | Auto mode wrap-up |
|---|---|
| ![Grace's plan waiting for approval](docs/screenshots/agent-plan-review.png) | ![An Auto task finished: tests written and run, one command skipped](docs/screenshots/agent-auto-wrapup.png) |
| **New task** | **Grace Light, with the side bar** |
| ![The Agent Home: mode, permissions and the CherryCola model card](docs/screenshots/agent-home.png) | ![Grace Agents in Grace Light](docs/screenshots/agent-light.png) |

The screenshots are from ToffeeTwirl 1.140.07069 with this branch's extension, run against a stand-in for `cherrycola` that replays scripted model replies (`test/fixtures/fake-cherrycola.js`). The folders, files, diffs, test run, review and undo in them are real.

### CherryCola in the IDE
The CherryCola card (Agent Home and side bar) is the IDE's model control:
- **Engine:** Automatic, Ollama, llama.cpp or LM Studio (`cherrycola backend`).
- **Model:** which installed model Grace Agents use (`grace.agent.model`), or "Follow CherryCola". "Make it CherryCola's default" runs `cherrycola use`. Also: "Grace Agents: Choose the Model…".
- **Preset:** CherryCola's sampling preset for agent turns (Code by default).
- **Start engine / Stop engine** (`cherrycola start|stop`), **Download model** (`cherrycola pull` in a terminal) and **CherryCola app** for every engine setting.
- The status bar shows the model, how many tasks are working, and how many wait for you.

Each turn runs `cherrycola ask - --preset code -o system_prompt=… -o context_length=16384`, so CherryCola keeps choosing the engine, loading the model and applying its own per-model settings.

### Headless from a terminal
`bin/grace-agent.js` runs the same agent without the window:

```
grace-agent --run "add a --verbose flag and a test for it"
grace-agent --plan "split cli.py into modules"     # print a plan, change nothing
grace-agent --allow "make lint" --json "fix the lint errors"
```

It works in the current folder (or `--dir`), prints each step, lists changed files and skipped commands, and exits 0 when done (2: no model server, 3: model not downloaded, 4: stopped). In the ToffeeTwirl tarball it is `resources/app/extensions/grace/bin/grace-agent.js`; run it with Node, or with ToffeeTwirl's own runtime: `ELECTRON_RUN_AS_NODE=1 /opt/toffeetwirl/twirl /opt/toffeetwirl/resources/app/extensions/grace/bin/grace-agent.js --help`.

### Settings (Grace Agents)
`grace.agent.defaultMode`, `grace.agent.model`, `grace.agent.preset`, `grace.agent.contextLength` (16384), `grace.agent.maxTurns` (30), `grace.agent.autoCommands`, `grace.agent.autoRunAnyCommand` (off), `grace.agent.commandTimeoutSeconds` (120), `grace.agent.allowCommands` (for tasks started from the command palette), `grace.agent.openHomeOnStartup` (on).

## Security of Grace Agents
The model's replies are untrusted proposals, and so is anything it read from your files:
- The allow list, "run any command" and the command switch are user settings only: a project's `.vscode/settings.json` can't widen them.
- Grace Agents only work in a **trusted** folder on this computer, and only with a model server on this computer (the same check as Explain and Ask).
- Every path is checked to stay **inside the project folder**: no absolute paths, no `..`, no symlinks that lead out, and never `.git/`. An existing file must be read before Grace may replace or edit it.
- In Plan mode nothing changes. In Build mode each change and command waits for you. In Auto mode a command runs only if it matches the allow list, and a command with `;`, `&`, `|`, `$`, backticks or a redirect never matches. `grace.agent.autoRunAnyCommand` lifts that and is off by default.
- Commands run in the project folder, as you, with a timeout, and their output is shown in full.
- Every change is recorded so the task can be undone. Prompts stay on this computer: they go to `cherrycola` on stdin.

## Security of Explain and Ask
Code from your files is untrusted data:
- Nothing is read or sent until you run a Grace command.
- The code goes to `cherrycola` on stdin (at most 6,000 characters), never on a command line. It's quoted between `<<<CODE` and `CODE>>>` markers, with the rules before it and the task repeated after it. Markers inside the code are removed.
- If `~/.config/grace/cherrycola.conf` points `ollama_url` or `lmstudio_url` at another computer, Grace refuses and says why. Your code never leaves this computer through Grace.
- The answer is plain text in an output panel. Grace can't edit, open or run anything; text in a file can still try to mislead the model.

## Screenshots
ToffeeTwirl IDE 1.140.07069 (the first release), following the system's dark and light style. "Grace: Explain Selection" has just run on the selected code. The answer comes from a stand-in model server that returns canned text.

| Dark | Light |
|---|---|
| ![ToffeeTwirl IDE, Grace Dark](docs/screenshots/toffeetwirl-dark.png) | ![ToffeeTwirl IDE, Grace Light](docs/screenshots/toffeetwirl-light.png) |

Grace's other states, tested in VSCodium 1.140 (the same VS Code version) before the first ToffeeTwirl build:

| | |
|---|---|
| ![The model isn't downloaded](docs/screenshots/grace-missing-model.png) | ![The Grace commands](docs/screenshots/grace-commands.png) |

## Build
The [ToffeeTwirl - Linux](.github/workflows/toffeetwirl-linux.yml) workflow:
1. It tests the Grace extension (`node --test src/stable/extensions/grace/test/*.test.js`).
2. It fetches VS Code at the commit in `upstream/stable.json`, applies VSCodium's patches with ToffeeTwirl's names (`utils.sh`, `product.json`), and builds `VSCode-linux-x64` with `bin/twirl`.
3. It checks the result, then uploads `ToffeeTwirl-linux-x64-<version>.tar.gz` and its `.sha256` as a workflow artifact.
4. Run it by hand with **publish** ticked, and it also publishes that tarball as a GitHub release. GraceOS's `toffeetwirl` package installs the release (the first is [1.140.07069](https://github.com/itsHarshDabas/ToffeeTwirl-IDE/releases/tag/1.140.07069)).

A local build needs Node (see `.nvmrc`), Python 3, `jq`, GCC, and `libkrb5-dev libxkbfile-dev libsecret-1-dev`: run `./dev/build.sh` (it also builds the tunnel CLI, which needs Rust). VSCodium's build documentation is in [docs/howto-build.md](docs/howto-build.md).

## What changed from VSCodium
- `product.json`: ToffeeTwirl's names, ids and links. `prepare_vscode.sh` merges it over VSCodium's.
- `utils.sh` and `dev/build.sh`: `APP_NAME=ToffeeTwirl`, `BINARY_NAME=twirl`, `ORG_NAME=GraceOS`.
- `src/stable/`: the icons (made from [icons/toffeetwirl/toffeetwirl.svg](icons/toffeetwirl/toffeetwirl.svg)) and the built-in `grace` extension.
- `.github/workflows/`: the ToffeeTwirl workflow replaces VSCodium's build, publish and issue-bot workflows. The lint workflows stay.
- VSCodium's README is now [docs/vscodium-readme.md](docs/vscodium-readme.md). Updates from VSCodium can still be merged in, since everything else is unchanged.

## License
MIT, like VSCodium and VS Code's source. See [LICENSE](LICENSE).
