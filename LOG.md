# Work log

## 28 September 2026: 0.1.0 public release preparation

- removed internal research material and all Amp-derived prompts; Oracle and Task children keep Pi's normal system prompt, and the Oracle appends `prompts/oracle.md` and gains `bash` for Git inspection
- added model aliases, serialized dial mode changes, and a Wut fallback when Luna lacks auth; documented npm installation and default model access
- reset the version to 0.1.0 for the first public release; earlier history is kept in the private archive repository
- real Pi run with only this checkout loaded, Medium (`openai-codex/gpt-6-sol`, medium): a parallel Oracle and Task returned the latest commit subject and the package version. Child sessions showed Pi's system prompt in both, the appended Oracle role only in the Oracle, no Amp text, an Oracle `bash` call running `git log -1 --format=%s` on `openai-codex/gpt-6-astra` at high, and a Task `read` of `package.json`
- a real Medium run with `astra` remapped to `openai-codex/gpt-6-sol` ran the Oracle on Sol at high, confirmed by its run metadata
- not run end to end: HUD turn race and Wut fallback (unit tests only), Anthropic-backed children, Windows
