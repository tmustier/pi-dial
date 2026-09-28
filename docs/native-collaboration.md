# Native Codex collaboration

High automatically enables parent–child conversations through OpenAI's native Codex message format. The resolved parent must use provider `openai-codex` and API `openai-codex-responses`, with High's Task facility enabled. Other modes and non-Codex fallbacks leave the six native tools off.

`Task` and `oracle` keep their existing subprocess paths. High's parent prompt prefers native `spawn_agent` for delegated work with its own model. Use `Task` for explicit worker overrides and custom tools; use `oracle` for the paired read-only expert.

A live test on 8 September 2026 verified each step: the child sent a question, the parent replied, and the child returned its final answer. The test used encrypted message arguments and a full-history fork.

This is an experimental compatibility layer, not complete Codex runtime parity. It requires Pi 0.87.0 and an authenticated `openai-codex` provider.

## Start a session

With Pi Dial installed, run `pi --dial high` or select `/dial high`. No separate collaboration launcher is needed.

For a standalone experiment from this checkout:

```bash
pi --no-extensions -e ./collaboration.ts --model openai-codex/gpt-6-sol
```

Disabling other extensions here isolates the experiment from other provider and tool-name converters. Only Codex models are supported. Do not switch this experimental session to another provider.

Do not load `collaboration.ts` alongside `index.ts`: the normal entry point now installs the same collaboration runtime. The standalone entry point is still useful for isolated transport tests.

Pi Dial changes only its six native tools, leaving `oracle`, `Task` and other extensions' tools untouched. Leaving High or manually changing the parent model or thinking level stops native workers. Returning to High creates a fresh worker registry.

Ordinary sessions retain their existing Codex provider registration. High temporarily installs the native SSE transport, restoring the previous registration when no native records need replay. After native records exist, Codex requests keep using this transport even outside High. Shutdown restores provider ownership so `/reload` cannot retain an invalidated extension stream.

Children use the parent's working directory and filesystem permissions. They do not get a sandbox or an automatic worktree. Assign separate worktrees for concurrent coding tasks.

## What the model sees

The provider offers these tools in the `collaboration` namespace:

| Tool | Arguments | Successful result |
|---|---|---|
| `spawn_agent` | `task_name`, `message`, optional `fork_turns` | `{"task_name":"/root/review"}` |
| `send_message` | `target`, `message` | empty output |
| `followup_task` | `target`, `message` | empty output |
| `wait_agent` | optional `timeout_ms` | `message` and `timed_out` |
| `list_agents` | optional `path_prefix` | `agents` with names and statuses |
| `interrupt_agent` | `target` | `previous_status` |

Model, reasoning and agent-type overrides are hidden, as allowed by Codex's configurable tool definitions. Children inherit their parent's model and thinking level.

The root is `/root`. A child named `review` is `/root/review`; its child `tests` is `/root/review/tests`. The host derives the sender from the executing session. Other branches can communicate using canonical paths.

Messages reach the backend as `type: "agent_message"`, with `author`, `recipient` and this envelope:

```text
Message Type: MESSAGE
Task name: /root
Sender: /root/review
Payload:
Should I review the migration too?
```

The three message kinds are `NEW_TASK`, `MESSAGE` and `FINAL_ANSWER`. Tool results do not carry mailbox contents.

## Conversation and timing

Spawning reserves capacity synchronously and returns before the child starts. A child can ask its parent a question while both conversations remain runnable.

`send_message` queues mail without starting an idle turn. `followup_task` starts an idle child or delivers a new assignment to an active one. Successful and failed child turns notify their direct parent without waking an idle parent.

`wait_agent` waits for mailbox activity or new user input. Free worker capacity does not complete a wait. Timeouts default to 30 seconds, clamp to at least 10 seconds and reject values above one hour.

Delivery uses Pi steering without authorizing an idle turn. A pending delivery remains mailbox activity until its exact host marker is restored into a model request. This avoids a race between queuing steering and starting a wait.

During sampling, the SSE adapter can yield after a complete reasoning or commentary item. It closes the current response and lets Pi continue with queued mail. It never cuts an unfinished tool call. Once final-answer output starts, new mail waits for a future turn.

Interrupting affects the named child, not its descendants. It rejects the root and the caller itself. The child remains available for follow-up tasks. Turn-generation checks prevent an interrupted run from completing its replacement assignment.

## History and replay

`fork_turns` defaults to `all`. `none` starts without surrounding conversation; a positive integer string selects the latest user turns. Each child's conversation then develops independently.

The copy excludes inherited collaboration messages and replaces the parent's collaboration role instructions. It retains completed tool-call/result pairs, while removing in-flight calls and orphaned results. A fork cannot claim that the parent's unfinished tool call completed.

Pi normally turns custom messages into user text. This add-on uses random, host-registered markers and restores the corresponding native records before transmission. It also captures native function calls before Pi's parser drops their metadata.

The sidecar preserves:

- raw function-argument JSON
- namespace and call identity
- absent, empty and populated `encrypted_function_args`
- optional internal passthrough metadata

For collaboration message tools, an empty encrypted-field list means plaintext. An absent or populated list selects the encrypted path. The adapter forwards the opaque `message` string as `encrypted_content`; it does not decrypt it locally.

Pi's empty-output placeholder is restored to the empty output expected by `send_message` and `followup_task`. Pi's plain-text tool errors and skipped-tool notices are JSON-wrapped for tools declaring an output schema. That error representation is an adapter behavior, not a claim of byte-for-byte Codex error parity.

## Limits

These limits are deliberate and visible in the implementation:

- children inherit active built-in coding tools and the six collaboration tools, but not parent extension tools
- worker sessions remain in memory; leaving High, changing the model or thinking, root reload, navigation or shutdown stops them
- native records persist in root session entries for replay, but worker histories, mailboxes and running state do not resume after a restart
- capacity is 4 active children, 32 retained children and 3 levels below the root
- each child turn has a 10-minute limit, including time spent waiting
- completed children retain their conversations; idle eviction and durable sleep are not implemented
- child compaction is disabled; root compaction is blocked once native records exist on the branch, even after leaving High, because text summarization would lose encrypted mailbox contents
- entering High without using collaboration does not block root compaction; existing compacted parent context can still be inherited
- collect results and start a clean session before switching providers or reaching the context limit; encrypted mail is replayable only through the Codex transport
- the transport uses SSE and does not implement Codex WebSocket transport, connection recovery or residency management
- prompt-cache session keys are preserved, but cache efficiency and usage accounting after an early yield have not been benchmarked
- the installed `pi-codex-conversion` package passed mocked CLI checks in both extension load orders; live converter combinations, grammar/deferred tools and other Codex models remain unverified
- native SSE replaces other Codex transport features while active or replaying native records; extensions that replace the transport during a running turn remain unsupported
- storage failures and process crashes do not have a durable mailbox recovery protocol

Inherited history is context, not fresh user approval. This add-on does not implement Codex Guardian's inherited-authority protocol. The encrypted path is a verified backend feature; these tests establish no end-to-end encryption guarantee.

## Verification

`npm run check` and `npm test` pass. The offline suite uses real Pi SDK sessions with fake SSE responses, without model inference. Both the standalone extension and automatic High pass plaintext and encrypted question/reply/completion flows, idle-child mail and follow-up reuse.

Regression tests cover activation, non-Codex fallbacks, unchanged Oracle and Task execution, provider restoration on deactivation and reload, replay in Medium, branch-scoped compaction blocking, history filtering, timeout behavior, interruption generations and shutdown during initialization.

A production-only package install passed the real Pi CLI loader, advertised all six namespaced tools and replayed a native call with mocked SSE. The same check passed with the installed `pi-codex-conversion` extension in either load order, with empty stderr and no extension errors.

Stream tests cover safe mid-response boundaries, malformed SSE, cancellation and raw metadata preservation. The SDK test validates function-call/result pairing and the exact empty success output. A schema regression test records that the reserved `wait_agent.timeout_ms` property must be `number`, even though the handler validates integer values.

Two explicit live probes are available from a development checkout:

```bash
# At most 3 requests, each with a 60-second timeout.
PI_AI_ROOT="$PWD/node_modules/@earendil-works/pi-ai" \
  node spikes/probe-native-codex-collaboration.mjs

# At most 12 requests and 120 seconds overall. Collaboration tools only.
node spikes/probe-collaboration-runtime.mjs

# Same bounds and tool allowlist, using index.ts and the real High preset.
node spikes/probe-collaboration-runtime.mjs --automatic
```

The transport probe verified plaintext native input, an encrypted namespaced `send_message` call, native function-call replay and exact recovery of the forwarded payload. In the live response, `encrypted_function_args` was absent. The empty and populated variants are covered by fixtures.

The automatic High live probe also completed the encrypted exchange in 8 requests, observing all three message directions with no extension errors. The standalone full-runtime probe returned:

```json
{
  "success": true,
  "requests": 8,
  "nativeMessageOccurrences": 8,
  "encryptedMessageOccurrences": 7,
  "childQuestionObserved": true,
  "parentReplyObserved": true,
  "childFinalObserved": true,
  "finalExact": true,
  "stopReason": "stop",
  "extensionErrors": 0
}
```

Message occurrences include repeated history in later requests. Success requires observing all three legs in actual native inputs, as well as the expected final text. A model claiming success without performing the exchange fails this check.

Earlier live runs exposed two errors that fake endpoint tests did not catch: the reserved wait schema rejected `integer`, and declared output schemas rejected Pi's synthetic non-JSON results in forked history. Both now have regression coverage. All live probes used fresh conversations and exposed no file-execution tools.

See [the Codex source interface investigation](codex-agent-interface.md) for the source contract. The source checkout is `6924ce6`; the relevant paths were also compared against public main at `74d3a5b`.
