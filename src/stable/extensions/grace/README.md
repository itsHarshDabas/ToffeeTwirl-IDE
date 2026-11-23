# Grace

Built into ToffeeTwirl IDE, GraceOS's IDE.

- **Themes:** Grace Dark and Grace Light, from the GraceOS design tokens. ToffeeTwirl follows the system's dark or light style.
- **Grace Agents** (`agent/`, `media/`): the Agent Home tab and the Grace Agents side bar. You describe a task; Grace plans it, makes folders and files, edits code and runs commands in the open folder, with the model CherryCola runs on this computer. Three modes: Plan, Build and Auto (headless). See the main README for the full tour.
   - `agent/protocol.js`: what the model is told and how its reply (plain tags like `<read path="…"/>` and `<write path="…">…</write>`) becomes actions. Pure, tested.
   - `agent/runner.js`: the agent loop, the project-folder sandbox, approvals, the Auto mode command allow list, and undo. No `vscode` import.
   - `agent/cherrycola.js`: `cherrycola ask -`, `status --json`, `use`, `backend`, `start` and `stop`.
   - `agent/ide.js` and `media/agent.js`: the webviews, diff review and model controls.
   - `bin/grace-agent.js`: the same agent from a terminal (`grace-agent --help`).
- **Explain and Ask:** "Grace: Explain Selection", "Grace: Ask About This File…" and "Grace: Ask…" (also in the editor's right-click menu). They run `cherrycola ask -` on this computer:
   - Nothing is read or sent until you run one.
   - The code goes in on stdin, quoted between markers as untrusted data (at most 6,000 characters).
   - If `~/.config/grace/cherrycola.conf` points at a model server on another computer, Grace refuses.
   - The answer is plain text in the "Grace" output. Grace can't edit, open or run anything.
- With `ai = off` in `~/.config/grace/desktop.conf` (GraceOS Settings → AI & Models), every Grace command, view, menu item and the status bar item disappear.

Run the tests with `node --test test/*.test.js`. `test/fixtures/fake-cherrycola.js` stands in for CherryCola there: it replays scripted replies and never runs a model.
