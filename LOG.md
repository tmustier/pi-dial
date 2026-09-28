# Work log

## 28 September 2026: children load installed extensions (0.1.1)

- Oracle and Task children now load the user's installed extensions instead of starting with `--no-extensions`, so hooks such as the Anthropic OAuth request rewrite apply to child calls; `inheritExtensions: false` restores isolation
- every child runs with `PI_DIAL_CHILD=1`; Pi Dial registers nothing there, and the command supervisor removes the variable from the worker's own Bash commands
- TypeScript check and all 102 tests passed at `04f4dbf`; the three new assertions fail against 0.1.0
- real Pi run at `04f4dbf` with a scratch agent directory holding only `pi-oauth`, this checkout and a probe extension; Medium parent `openai-codex/gpt-6-sol`. A parallel Oracle (`anthropic/claude-fable-5-1`, high) ran `git log -1 --format=%s` and returned the commit subject, and a Task (`anthropic/claude-opus-5-5`, medium) read `package.json` and returned `VERSION=0.1.1`
- the probe showed both children with `PI_DIAL_CHILD=1`, no `oracle` or `Task` tools, and Anthropic requests whose `system` held only the Claude Code block with the Pi prompt moved into a leading `<system-reminder>` user message, so `pi-oauth` rewrote them
- the first run's parent event file was missing afterwards; two further runs kept theirs and the cause was not found. Not run: the installed npm package path, colleagues' extension sets, Windows

## 28 September 2026: 0.1.0 public release preparation

- removed internal research material and all Amp-derived prompts; Oracle and Task children keep Pi's normal system prompt, and the Oracle appends `prompts/oracle.md` and gains `bash` for Git inspection
- added model aliases, serialized dial mode changes, and a Wut fallback when Luna lacks auth; documented npm installation and default model access
- reset the version to 0.1.0 for the first public release; earlier history is kept in the private archive repository
- real Pi run with only this checkout loaded, Medium (`openai-codex/gpt-6-sol`, medium): a parallel Oracle and Task returned the latest commit subject and the package version. Child sessions showed Pi's system prompt in both, the appended Oracle role only in the Oracle, no Amp text, an Oracle `bash` call running `git log -1 --format=%s` on `openai-codex/gpt-6-astra` at high, and a Task `read` of `package.json`
- a real Medium run with `astra` remapped to `openai-codex/gpt-6-sol` ran the Oracle on Sol at high, confirmed by its run metadata
- not run end to end: HUD turn race and Wut fallback (unit tests only), Anthropic-backed children, Windows
