# Changelog

## [0.1.0] - 2026-09-28

First public release.

### Added

- A four-position dial (`low`, `medium`, `high`, `ultra`) that switches the parent model, reasoning level, paired Oracle and Task worker settings together, with a HUD, a shortcut, `/dial` commands and a `--dial` flag.
- `oracle`, a read-only second-opinion subprocess that sees the parent thread and can inspect the workspace, including Git history.
- `Task`, isolated parallel execution workers with per-mode presets, strict per-call model and thinking overrides, and supervised long-running Bash commands.
- Model aliases (`opus`, `sol`, `astra`, `fable`) that can be remapped to another provider, plus layered JSON configuration, child routing and inactive-dial fallbacks.
- Native Codex collaboration tools in High for compatible `openai-codex` parents (experimental).
- `/wut`, an observer overlay and stuck-agent watchdog.
- Forensic run artifacts for every Oracle and Task child.
