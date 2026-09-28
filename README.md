# Pi Dial

A configurable four-position dial for Pi. Each preset changes the parent model, reasoning effort,
paired read-only Oracle, and isolated Task worker settings as one unit. Pi's own system prompt
and tools stay in place for the parent and every child. Oracle and Task can also take strict
per-call model and thinking overrides when one run needs a different worker.

The defaults build on Amp's Low, Medium, High, and Ultra modes with updated model pairings. Amp
was used only as a research and parity surface; the extension has no Amp runtime, account, CLI, or
backend dependency.

## Default dial

| Mode | Parent | Oracle | Intent |
|---|---|---|---|
| `low` | `anthropic/claude-opus-5-5`, medium | `openai-codex/gpt-6-astra`, high | Opus with moderate reasoning |
| `medium` | `openai-codex/gpt-6-sol`, medium | `openai-codex/gpt-6-astra`, high | Balanced default |
| `high` | `openai-codex/gpt-6-sol`, xhigh | `anthropic/claude-fable-5-1`, high | Maximum Sol reasoning with a Fable second opinion |
| `ultra` | `anthropic/claude-fable-5-1`, high | `openai-codex/gpt-6-sol`, high | Fable-led implementation with a Sol second opinion |

Low uses `anthropic/claude-opus-5-5` at medium reasoning without fallback candidates.

Child routing is opt-in. The built-in `childRouting` arrays are empty, so Oracle and Task use their
explicit child configuration or inherit from the parent. You can add provider and model glob rules
for either child type. Routing has no provider-specific or model-specific selection logic.

The dial preserves tools owned by Pi and other extensions, including MCP and messaging tools.
It adds `oracle` and `Task`, which report an error when the active mode disables them. When the
dial is inactive, both use the configurable [inactive fallbacks](#inactive-fallbacks).
High also enables six [native collaboration tools](#native-collaboration-in-high) when the parent
uses the OpenAI Codex Responses API. The dial toggles only those six tools.
Pi Dial also includes [Wut](#wut), which works in every mode and while the dial is inactive.

## Install

Install from npm:

```bash
pi install npm:@tmustier/pi-dial
```

Update an existing installation through Pi's package manager, then reload extension code:

```bash
pi update --extension npm:@tmustier/pi-dial
```

To track the repository instead, use `git:github.com/tmustier/pi-dial` as the source.

Run Pi's top-level `/reload` command in each existing session, or restart Pi. `/dial reload-config`
only reloads JSON configuration; it cannot load newly installed extension code. If the standalone
`~/.pi/agent/extensions/wut.ts` is still installed, remove that symlink when upgrading to this
version so Pi loads only one `/wut` command and watchdog.

From a local checkout:

```bash
pi install .
```

For local development without installing:

```bash
pi -e ./index.ts
```

Requires Pi 0.87.0 or later. The package pins `pi-ai` 0.87.0 as a runtime dependency for its
Responses converter and parser subpaths, which Pi's extension loader does not provide.

### Model access

The built-in defaults are our recommended pairings. They need two Pi logins:

- `openai-codex` for GPT-6 Sol (Medium, High, Ultra's Oracle and inactive Task) and GPT-6 Astra
  (Low and Medium Oracles);
- `anthropic` for Claude Opus 5.5 (Low) and Claude Fable 5.1 (Ultra, High's Oracle and the
  inactive Oracle).

Wut uses `openai-codex/gpt-5.6-luna` when it is authenticated, and otherwise the session model.

Use `/login` in Pi for each provider. A mode whose models are unavailable is dimmed in the HUD with
the reason, and activation fails clearly instead of silently substituting a different model or
reasoning level. Configure explicit fallback candidates when substitution is wanted.

To follow the defaults through a different provider, remap the model alias rather than
redefining modes. For example, to use Fable through another provider:

```json
{ "models": { "fable": "my-provider/claude-fable-5-1" } }
```

Every default that uses `fable` then selects that model. The built-in aliases are `opus`, `sol`,
`astra` and `fable`. See [Configure](#configure) to change any mode completely.

## Use

```text
/dial                 open the dial HUD
/dial low             activate Low
/dial medium          activate Medium
/dial high            activate High
/dial ultra           activate Ultra
/dial next            cycle to the next position
/dial status          show the loaded Pi Dial version, active model, and reasoning
/dial reload-config   reload JSON configuration and the active preset
```

### Dial HUD

`/dial` and the shortcut open a transient dial HUD above the editor, modelled on Amp's:

- a gauge with one detent per on-dial mode, colored with the active mode's theme color;
- `←`/`→` turn the dial and `1`–`4` jump straight to a detent; changes apply immediately while Pi
  is idle and queue visibly (`queued — applies when the current turn settles`) while Pi is busy;
- the panel shows the resolved Agent and Oracle model/effort pairing and the mode's description;
- unavailable modes are dimmed with the reason (missing model or unsupported reasoning level);
- `Tab` switches to an extras list for modes configured with `"dial": false`; engaging one
  unlatches the gauge and shows `<label> engaged — turn the dial to switch back`;
- `Esc` closes the HUD, it auto-closes after `hudAutoCloseMs` (default 2400 ms) of inactivity, and
  ordinary typing closes it while forwarding the typed text to the editor.

The default shortcut is `Ctrl+Shift+U`: it opens the HUD, and pressing it again turns the dial one
detent. Without UI (headless `-p` runs) the shortcut and `/dial next` cycle directly. Change or
disable the shortcut in configuration. Do not bind `Ctrl+Shift+D`: Pi consumes that chord globally
for its debug log before extension shortcuts run.

The footer status chip shows the active mode in its theme color, the thinking level, and a pending
transition (`dial:high xhigh → ultra`) while a queued switch waits for the turn boundary.

CLI flags:

```bash
pi --dial high
pi --dial-config ./team-dial.json
```

Mode changes are atomic at user-turn boundaries:

- when Pi is idle, the model, reasoning, and status change immediately;
- during a response, the selection is queued and applied after that response settles;
- existing conversation history remains on the current branch;
- in-flight Oracle and Task workers keep the snapshot they started with;
- leaving native collaboration stops its in-memory workers, including retained idle children;
- manually changing Pi's model or reasoning deactivates the dial rather than leaving a misleading
  partially applied preset; `oracle` and `Task` then use the inactive fallbacks below.

The active mode is stored as a Pi custom session entry and restored on resume. Set
`persistSelection` to `false` to use the configured default on each start. An explicit Pi
`--model`, `--provider`, or `--thinking` startup option takes precedence over the default or
persisted dial selection and starts the dial inactive for that run without clearing the saved mode.
An explicit `--dial` still wins when both are supplied.

## Native collaboration in High

`/dial high` automatically enables six native `collaboration` tools when the resolved parent is
an `openai-codex` model using `openai-codex-responses`. This includes the default Sol parent.
Other modes, an inactive dial, non-Codex parents and High with `task: false` leave these tools off.
Passing `Task({ mode: "high", ... })` alone does not activate native collaboration for the parent.

The parent is instructed to prefer `spawn_agent` for delegated work with its own model. Children
can exchange messages, ask questions and retain their conversations for follow-up tasks.
`Task` remains an isolated subprocess for explicit worker presets, model overrides and custom
tools. `oracle` keeps its existing read-only subprocess path and model pairing.

This remains experimental. Native children inherit built-in tools only, share filesystem access,
and stop when you leave High, change the model or reload. Once native records exist, compaction
is blocked on that branch even after leaving High. Codex requests retain the native SSE transport
for history replay until you start a clean session or navigate to a branch without native records.
Collect the results and start a new session before changing providers or reaching the context limit.

For a standalone experiment without the dial, load only `collaboration.ts`:

```bash
pi --no-extensions -e ./collaboration.ts --model openai-codex/gpt-6-sol
```

Do not load `collaboration.ts` alongside `index.ts`; the normal entry point already installs it.
Read the [verification and compatibility limits](docs/native-collaboration.md) before using it for real work.

## Wut

`/wut` shows a plain-language update about the agent's activity since your last message without
interrupting it. `/wut <question>` asks something specific. The overlay supports follow-up questions,
empty Enter to refresh, Ctrl+O to copy the answer, PgUp/PgDn to scroll and Esc to close. In
non-TUI modes, the answer is shown as a notification or printed to stdout.

Wut uses `openai-codex/gpt-5.6-luna` at low reasoning as its observer, falling back to the current
session model if Luna is unavailable. Its watchdog is on by default: after 15 minutes of activity,
it checks for repeated, clearly stuck behavior and may steer the agent with up to two auditable
prods per user message. Use `/wut auto off` or `/wut auto on` to toggle it. These are the existing
Wut behaviors, now packaged with Pi Dial; Wut does not change the selected dial mode.

## Oracle

`oracle({ task, model?, thinking? })` launches a fresh, zero-shot Pi subprocess with the mode's
paired model and reasoning level. It receives a bounded serialization of the active parent thread,
excluding assistant thinking blocks. Only its final answer returns to the parent.

The Oracle runs with Pi's normal system prompt plus the Oracle instructions in
[`prompts/oracle.md`](prompts/oracle.md), which make it a zero-shot, read-only reviewer. Its default
tools are `read`, `bash`, `grep`, `find`, and `ls`; `bash` lets it inspect Git diffs and history.
Read-only behaviour comes from its instructions, not from the tool set.

A per-call `model` or `thinking` value overrides the resolved default for that call. An omitted
field keeps its resolved value, including a value from a matching route. Pi Dial rejects missing or
unauthenticated models and unsupported exact thinking levels. It does not silently clamp or
substitute an explicit override.


## Task

`Task({ description, prompt, mode?, model?, thinking? })` launches a fresh execution
worker. It does not receive the parent transcript, communicate with sibling workers or accept
steering after launch. Put the full brief in `prompt`; only the final summary returns.

By default a Task worker inherits the selected mode's resolved parent model and reasoning level.
That is an explicit Pi choice because Amp does not publish its Task mode-to-model mapping. Pass
`mode` to select a different configured worker preset. The tool schema enumerates every configured
mode. Pass `model` and/or `thinking` only for an intentional strict per-call override.

Multiple Task calls in one assistant message fan out in parallel. Pi Dial does not impose its own
concurrency limit; all calls begin immediately. The parent prompt treats Task as a fan-out-first tool: it
should normally delegate multiple independent parts together, and do a lone ordinary execution
task itself. A single Task remains useful when isolation, a different model or preset, or context
containment is the reason to delegate. Workers have no whole-agent deadline. When a Bash command
is still running after the preset's `commandReviewMs` interval (2 minutes by default), the Bash
tool returns a command ID without stopping the process. The same worker can use `command_session`
to list commands, inspect current output and status, wait for another bounded interval, or abort a
command. Each response shows a tail of the output and points to the full log. Cancellation still
propagates to running workers. Cancelling an individual Bash review wait or
`command_session wait` only cancels that wait; use `command_session abort` to stop the command
explicitly.

Children load your installed extensions, like a normal Pi session, so provider and request hooks
such as authentication or request rewriting also apply to Oracle and Task calls. Pi Dial itself
stays inactive inside a child: every child runs with `PI_DIAL_CHILD=1`, which the command
supervisor removes again from the worker's own Bash commands. A child's active tools are still
limited to its configured `tools`. Task workers with Bash enabled load Pi Dial's command supervisor
first, so it owns `bash` and `command_session`; explicitly configured extensions load alongside it.
Project context files and skills remain enabled by default, and project extensions load only where
Pi has a saved project-trust decision. Set `inheritExtensions` to `false` to start a child without
your installed extensions. Configure child `extensionPaths`, `skillPaths`, `inheritContext`,
`inheritSkills`, and `inheritExtensions` explicitly when a worker needs a different surface.

## Run forensics

Every Oracle and Task child run persists forensic artifacts so a failed, cancelled, or
context-overflowed worker does not destroy its evidence. Each run gets a directory under
`<agent dir>/pi-dial/runs/<timestamp>-<kind>-<id>/` (agent dir is `~/.pi/agent` unless
`PI_CODING_AGENT_DIR` overrides it) containing:

- `input.md` — the composed child input brief.
- `session.jsonl` — the child's full Pi session transcript; children run with `--session`
  instead of `--no-session`, so partial work survives and can be inspected or manually resumed
  with `pi --session <path>`.
- `events.jsonl` — the child's streamed JSON events as received.
- `stderr.log` — the child's complete stderr.
- `cmd-<hex>.log` — complete output from each supervised Bash command.
- `meta.json` — kind, mode, provenance, model-selection source, model and thinking level, timings,
  command-review interval, exit code or terminating signal, stop reason, process-exit status,
  tool-call count and assistant-turn count.

Failure results cite the run directory (`Run artifacts: …`); successful results carry the paths
in tool details only. Tool progress updates stream real child activity (tool calls and the last
tool used) derived from the event stream.

Retention is bounded: runs older than 14 days are pruned, at most 60 runs are kept, and runs
younger than 1 hour are never pruned. A live-owner marker protects longer active runs. Pruning is
best-effort and happens at the start of each new run.

Supervised command process trees live only for their Task session and are aborted when that session
shuts down. A process that deliberately detaches into a new operating-system process group is
outside that supervision. Durable delegation that must survive its worker still belongs to a
dedicated substrate such as pi-subagents.

## Inactive fallbacks

Explicit parent selectors, manual model or reasoning changes, and resumed inactive sessions leave
the dial inactive. Oracle and Task then use the top-level `inactive` fallback configuration:

- Oracle tries `anthropic/claude-fable-5-1` at high, then `openai-codex/gpt-6-sol` at xhigh. A
  candidate matching the parent session's current model is skipped so the Oracle never pairs the
  parent model with itself; it is reconsidered only when no differing candidate is authenticated.
- Task uses `openai-codex/gpt-6-sol` at medium.

Structured tool details and `meta.json` record the resolved model, thinking level, mode and
selection source. Normal child answers are unchanged; when a lower fallback candidate is used, the
answer includes a short fallback note. An explicit Task `mode` still works while the dial is
inactive. Set either inactive fallback to `false` to restore the previous hard error. Use `/dial` to
reactivate a paired preset. In the TUI, every Task call shows its resolved worker route, for example
`Task: <description> (gpt-6-sol • medium)`. The title uses the model's short ID rather than its
provider-qualified configuration value and remains available when a saved session is resumed.

`inactive.oracle` and `inactive.task` accept the same child keys as mode-level `oracle`/`task`
except `model` and `thinking`, which come from the required non-empty `fallbacks` list. The first
authenticated candidate supporting its exact thinking level wins. A higher configuration layer
that overrides a disabled fallback with an object rebuilds from the built-in defaults, so
re-enabling needs only a `fallbacks` list.

## Configure

Configuration layers, from lowest to highest precedence:

1. built-in defaults;
2. `~/.pi/agent/pi-dial.json`;
3. `<cwd>/.pi/pi-dial.json`;
4. `--dial-config <path>` or `PI_DIAL_CONFIG`.

Any model field accepts either a `provider/model` spec or a model alias defined under `models`.
Aliases merge by name across layers and resolve after all layers load, so remapping an alias in
any layer moves every default and custom setting that uses it. Alias values must be
`provider/model` specs. Oracle and Task per-call `model` overrides accept aliases too.

Relative prompt, extension, and skill paths resolve from the JSON file that declares them. Arrays
replace the preceding layer. Unknown properties are errors so misspellings do not silently weaken a
preset. Mode-level `tools`/`optionalTools` keys are rejected: the dial does not manage tools owned
by Pi or other extensions. `oracle.tools` and `task.tools` define subprocess child tool sets;
native collaboration children inherit the parent's active built-in tools.

Whole-agent `timeoutMs`, `timeoutRecoveryMs`, and `maxTimeoutMs` settings are no longer supported.
Remove them from existing configuration. Set Task `commandReviewMs` to control when a running Bash
command returns control to its worker; this does not stop the worker or command.

Example opt-in configuration:

```json
{
  "defaultMode": "medium",
  "order": ["low", "medium", "high", "ultra"],
  "shortcut": "ctrl+shift+u",
  "hudAutoCloseMs": 2400,
  "persistSelection": true,
  "modes": {
    "low": {
      "color": "success",
      "dial": true,
      "model": "anthropic/claude-opus-5-5",
      "thinking": "medium",
      "fallbacks": [],
      "oracle": {
        "model": "openai-codex/gpt-6-astra",
        "thinking": "high",
        "promptFile": "./prompts/oracle.md",
        "tools": ["read", "bash", "grep", "find", "ls"],
        "inheritContext": true,
        "inheritSkills": true,
        "inheritExtensions": true,
        "outputLimitChars": 50000,
        "maxContextChars": 120000
      },
      "task": {
        "model": "anthropic/claude-opus-5-5",
        "thinking": "medium",
        "promptFile": "./prompts/worker-notes.md",
        "tools": ["read", "bash", "edit", "write", "grep", "find", "ls"],
        "extensionPaths": [],
        "skillPaths": [],
        "inheritContext": true,
        "inheritSkills": true,
        "inheritExtensions": true,
        "commandReviewMs": 120000,
        "outputLimitChars": 50000
      }
    }
  },
  "inactive": {
    "oracle": {
      "fallbacks": [
        { "model": "anthropic/claude-fable-5-1", "thinking": "high" },
        { "model": "openai-codex/gpt-6-sol", "thinking": "xhigh" }
      ]
    },
    "task": {
      "fallbacks": [{ "model": "openai-codex/gpt-6-sol", "thinking": "medium" }]
    }
  },
  "models": {
    "fable": "my-provider/claude-fable-5-1"
  },
  "childRouting": {
    "oracle": [
      {
        "parentModel": "vendor-a/writer-*",
        "model": "vendor-b/reviewer-model",
        "thinking": "high"
      }
    ],
    "task": []
  }
}
```

Oracle and Task children always start from Pi's normal system prompt, including project context
files and skills unless disabled. A child `promptFile` is appended to that prompt as extra
instructions; it never replaces it. The built-in Oracle uses `prompts/oracle.md`, and Task workers
have no extra instructions by default. Every Task brief is wrapped in a short message telling the
worker it is isolated, should do and verify the work, and should return a concise summary.

The former `parentPrompt`, `includeRuntimeContext`, and mode-level `promptFile` settings were
removed. Configuration that still uses them fails with a message asking you to delete them.

A per-call `model` or `thinking` value overrides configuration for that call. Otherwise, child
model precedence is: explicit mode child configuration, the first matching `childRouting` rule,
then parent inheritance. `parentModel` accepts any provider/model glob where `*` and `?` are
wildcards. Routes apply only when the child inherits its model and thinking from the parent. A
matching route is tried first without removing inherited candidates, so an unavailable route can
fall back visibly. The `oracle` and `task` arrays replace lower configuration layers. Both default
to `[]`.

A new custom mode also requires `label`, `description`, `model`, and `thinking`. Set
`oracle` or `task` to `false` to disable that facility for a mode.

`color` names a Pi theme color used for the mode's gauge, HUD accents, and status chip. The
built-in detents use `success`, `accent`, `thinkingHigh`, and `thinkingMax`. `dial` defaults to
`true`; set it to `false` to move a custom mode off the four-detent gauge into the HUD's `Tab`
extras list while keeping `/dial <mode>` and cycling order intact. At least one mode must stay on
the dial. `hudAutoCloseMs` accepts a positive integer or `false` to disable idle auto-close.

`thinking` accepts Pi's `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` values. Pi
Dial verifies the configured parent model supports the exact level before activation.

## Development

```bash
npm install --ignore-scripts
npm run check
npm test
```

`PI_DIAL_CHILD_COMMAND` optionally overrides the child Pi invocation with a JSON object
(`{"command": "...", "prefixArgs": ["..."]}`). The test suite uses it to fake child agents; it can
also point Oracle and Task workers at a specific Pi binary. It is trusted-process input: anything
able to set Pi's environment already controls the process, but treat it accordingly and do not
forward untrusted values into it. Without an override, Pi Dial reuses a dedicated packaged Pi
executable or a current `.js`, `.cjs` or `.mjs` entry point. A generic Node or Bun host with any
other launcher invokes `pi` from `PATH`, so a shell script is never passed to Node as JavaScript.
