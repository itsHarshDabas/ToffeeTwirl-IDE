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
   - "Grace: Explain Selection" (also in the editor's right-click menu), "Grace: Ask About This File…" and "Grace: Ask…" (also the ✦ Grace item in the status bar).
   - They run only [CherryCola](https://github.com/itsHarshDabas/CherrySoda) on this computer (`cherrycola ask -`, with Ollama or LM Studio). Answers stream into the "Grace" output and can be cancelled.
   - If the model isn't downloaded, "Download the model" runs `cherrycola pull` in a terminal.
   - With AI off in GraceOS Settings → AI & Models (`ai = off` in `~/.config/grace/desktop.conf`), every Grace command, menu item and the status bar item disappear, live. Everything else in the IDE works the same.
- Only Linux x64 is built. VSCodium's macOS, Windows and other Linux builds, and its update service, aren't part of ToffeeTwirl; on GraceOS, pacman updates it.

## Security of Grace
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
1. It tests the Grace extension (`node --test src/stable/extensions/grace/test/lib.test.js`).
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
