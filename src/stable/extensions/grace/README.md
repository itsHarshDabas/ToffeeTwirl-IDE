# Grace

Built into ToffeeTwirl IDE, GraceOS's IDE.

- **Themes:** Grace Dark and Grace Light, from the GraceOS design tokens. ToffeeTwirl follows the system's dark or light style.
- **Grace, the local AI:** "Grace: Explain Selection", "Grace: Ask About This File…" and "Grace: Ask…" (also in the editor's right-click menu and the status bar). They run `cherrycola ask -` on this computer:
   - Nothing is read or sent until you run one.
   - The code goes in on stdin, quoted between markers as untrusted data (at most 6,000 characters).
   - If `~/.config/grace/cherrycola.conf` points at a model server on another computer, Grace refuses.
   - The answer is plain text in the "Grace" output. Grace can't edit, open or run anything.
   - With `ai = off` in `~/.config/grace/desktop.conf` (GraceOS Settings → AI & Models), the commands, menu items and status bar item disappear.

Run the tests with `node --test test/lib.test.js`.
