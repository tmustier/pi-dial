# What Codex shows collaborating agents

The [opt-in implementation and live verification](native-collaboration.md) now build on this source investigation. The compatibility limits remain explicit.

## The important differences

Codex V2 gives agents named conversations, a common set of collaboration tools,
and messages that enter the recipient's model context separately from tool results.
The unusual parts are native `agent_message` input items, encrypted message fields,
conversation inheritance and delivery during an unfinished model response.

This is the interface to target for pi-dial. Renaming Pi custom messages would not
reproduce it exactly.

Inspected on 8 September 2026. The source checkout is `6924ce6`; we also fetched
public main at `74d3a5bf1046f004ee33a200ee497dc7593a5687`. The core, protocol and tool
source directories are identical between those snapshots. Links below use the latter.

Codex still contains V1 as well as V2. Configuration and model metadata select the
version. The following describes V2, not every Codex installation.

## The six tools

The default namespace is `collaboration`. Role instructions show direct calls such
as `functions.collaboration.spawn_agent`. By default these tools are excluded from
the JavaScript Code Mode `tools.*` namespace. Configuration can alter that exposure.

| Tool | Inputs | Successful model-facing result |
|---|---|---|
| `spawn_agent` | required `task_name`, `message`; optional `fork_turns`, and configured model, reasoning and agent-type options | `{"task_name":"/root/review"}` by default; optional nickname when metadata hiding is disabled |
| `send_message` | `target`, `message` | empty successful tool output |
| `followup_task` | `target`, `message` | empty successful tool output |
| `wait_agent` | optional `timeout_ms` | `{"message":"Wait completed.","timed_out":false}` for mailbox activity |
| `list_agents` | optional `path_prefix` | an `agents` array |
| `interrupt_agent` | `target` | `previous_status` |

V2's wait has no target-agent argument. It waits on the caller's mailbox. It also
returns for new user input or timeout. Defaults in this snapshot are 30 seconds,
a 10-second minimum and a one-hour maximum. Smaller requested timeouts are clamped;
larger than maximum are errors.

There is no dedicated ask-parent or answer-child tool. An agent sends a normal
message and can use `wait_agent` while it needs the reply. There is also no V2
`close_agent` or `resume_agent` tool in this registration path. Those belong to V1.

Sources: [tool schemas](https://github.com/openai/codex/blob/74d3a5bf1046f004ee33a200ee497dc7593a5687/codex-rs/core/src/tools/handlers/multi_agents_spec.rs),
[registration](https://github.com/openai/codex/blob/74d3a5bf1046f004ee33a200ee497dc7593a5687/codex-rs/core/src/tools/spec_plan.rs#L1284-L1344),
[wait implementation](https://github.com/openai/codex/blob/74d3a5bf1046f004ee33a200ee497dc7593a5687/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs).

## Identities and starting context

The root is `/root`. If it creates `review`, that child is `/root/review`.
If that child creates `tests`, the descendant is `/root/review/tests`.

A parent can address its child by its short name. Other branches use the full path.
The interface supports messaging across the tree, not only parent-child pairs.
The host derives the sender identity from the sending session.

A spawn normally copies the parent's conversation. `fork_turns` defaults to `"all"`;
`"none"` starts without surrounding conversation, and `"3"` selects the latest 3 turns.
The child's conversation then develops independently. This is copied context, not
shared model memory.

The copy is filtered. Codex removes inherited native agent messages and parent role
hints, handles compacted history too, and installs the child's role instructions.
Full-history forks try to preserve the reusable prompt prefix. In thread-owned
Guardian mode, inherited user messages retain their inherited-authority marking;
a copy of user text must not become a new local approval.

Root and child instructions explain the agent tree, available tools, how to delegate,
and the message format. They say messages arrive in the analysis channel. Children
are told that a final answer goes back to their parent. These instructions can come
from configuration, the model catalog or bundled defaults. Eligible children get
collaboration tools too; some model overrides produce leaf workers without them.

Sources: [spawn defaults](https://github.com/openai/codex/blob/74d3a5bf1046f004ee33a200ee497dc7593a5687/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs#L276-L325),
[history preparation](https://github.com/openai/codex/blob/74d3a5bf1046f004ee33a200ee497dc7593a5687/codex-rs/core/src/agent/control/spawn.rs#L817-L1124),
[role instructions](https://github.com/openai/codex/blob/74d3a5bf1046f004ee33a200ee497dc7593a5687/codex-rs/core/src/session/multi_agents.rs).

## The message the receiving model gets

The readable form is:

```text
Message Type: MESSAGE
Task name: /root
Sender: /root/review
Payload:
Should I also review the migration?
```

`Task name` names the recipient, not the sender. The kinds are `NEW_TASK`, `MESSAGE`
and `FINAL_ANSWER`.

Codex sends this as a distinct Responses input item:

```json
{
  "type": "agent_message",
  "author": "/root/review",
  "recipient": "/root",
  "content": [
    {
      "type": "input_text",
      "text": "Message Type: MESSAGE\nTask name: /root\nSender: /root/review\nPayload:\nShould I also review the migration?"
    }
  ]
}
```

Optional IDs and internal metadata are omitted here. The ordinary Pi conversion
produces `role: "user"` content instead. Matching the words alone therefore does
not match the request representation. The open-source client shows the request;
it does not reveal the server's final token-level representation.

Sources: [model input conversion](https://github.com/openai/codex/blob/74d3a5bf1046f004ee33a200ee497dc7593a5687/codex-rs/protocol/src/protocol.rs#L803-L914),
[readable message format](https://github.com/openai/codex/blob/74d3a5bf1046f004ee33a200ee497dc7593a5687/codex-rs/core/src/context/inter_agent_message.rs).

## The encrypted path

The `message` argument in spawn, send and follow-up schemas has the extension
`"encrypted": true`. The returned argument may contain opaque encrypted text.
The local Codex application forwards that string; it does not decrypt it here.

The recipient's input has a readable envelope followed by the opaque block:

```json
"content": [
  {"type":"input_text","text":"Message Type: MESSAGE\nTask name: /root\nSender: /root/review\nPayload:\n"},
  {"type":"encrypted_content","encrypted_content":"<opaque message string>"}
]
```

`encrypted_function_args` is separate function-call metadata. Tests use a populated
value such as `["message"]`; the encrypted body itself is the `arguments.message`
string. For these tools in the `collaboration` namespace, an explicitly empty array
selects the plaintext path. An absent or non-empty array selects the encrypted path.
Preserving only parsed arguments loses this distinction.

The code and mock-server tests prove how Codex forwards plaintext and encrypted
forms. They do not establish how OpenAI creates or interprets encrypted content,
why it chose that design, or whether every model/account can use it. Do not describe
this as proven end-to-end encryption or a shared hidden memory between agents.

Sources: [encrypted schema flag](https://github.com/openai/codex/blob/74d3a5bf1046f004ee33a200ee497dc7593a5687/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L181-L239),
[plaintext detection](https://github.com/openai/codex/blob/74d3a5bf1046f004ee33a200ee497dc7593a5687/codex-rs/core/src/tools/router.rs#L44-L61),
[dispatch](https://github.com/openai/codex/blob/74d3a5bf1046f004ee33a200ee497dc7593a5687/codex-rs/core/src/tools/handlers/multi_agents_v2.rs#L58-L85),
[request fixtures](https://github.com/openai/codex/blob/74d3a5bf1046f004ee33a200ee497dc7593a5687/codex-rs/core/tests/suite/subagent_notifications.rs#L2090-L2249).

## Delivery while work continues

`send_message` queues mail without starting an ordinary idle conversation.
`followup_task` can start an idle child and deliver promptly to one already working.
It cannot target the root. Interrupting the root or interrupting oneself is also rejected.

The receiving session holds a FIFO mailbox and broadcasts mailbox activity to waiters.
`wait_agent` subscribes before checking already-pending input, avoiding a missed-message
race. It returns a short result; the actual mail enters the next model input separately.

During generation, Codex checks for mail after a completed reasoning item or commentary
message. If mail exists, it can end that request early and continue with the message
included. It does not modify already-generated tokens or deliver at arbitrary byte boundaries.
The tool description promises delivery after a pending tool finishes when one is running.

Once an agent has produced final-answer text, queue-only mail normally waits for the
next turn. This avoids restarting a finished answer just because a late update arrived.
There is a separate durable-sleep integration: mail can wake a thread marked as durably
asleep even without `trigger_turn`. That is an exception to ordinary idle behavior.

Sources: [mailbox](https://github.com/openai/codex/blob/74d3a5bf1046f004ee33a200ee497dc7593a5687/codex-rs/core/src/session/input_queue.rs#L68-L198),
[mid-response delivery](https://github.com/openai/codex/blob/74d3a5bf1046f004ee33a200ee497dc7593a5687/codex-rs/core/src/session/turn.rs#L2475-L2520),
[finished-answer handling](https://github.com/openai/codex/blob/74d3a5bf1046f004ee33a200ee497dc7593a5687/codex-rs/core/src/stream_events_utils.rs#L488-L503),
[durable sleep exception](https://github.com/openai/codex/blob/74d3a5bf1046f004ee33a200ee497dc7593a5687/codex-rs/core/src/tasks/mod.rs#L412-L505).

## Completion and reuse

On terminal child-turn events, the host forwards a `FINAL_ANSWER` envelope to the
direct parent. Failures also have a completion-envelope path. Successful final text
is taken from the child's output; no extra summarising model call is made in this path.
Sending a result does not ordinarily start a new idle parent turn.

Finishing a task does not destroy the child's conversation. A new assignment can
continue it. The host separately limits active work and loaded child sessions.
Under pressure it can save and unload eligible inactive children, then reload them
when needed. It does not unload a running child or one with pending mail through
this eviction path.

Sources: [terminal result forwarding](https://github.com/openai/codex/blob/74d3a5bf1046f004ee33a200ee497dc7593a5687/codex-rs/core/src/session/mod.rs#L2162-L2325),
[result formatting](https://github.com/openai/codex/blob/74d3a5bf1046f004ee33a200ee497dc7593a5687/codex-rs/core/src/session_prefix.rs#L19-L45),
[unloading idle children](https://github.com/openai/codex/blob/74d3a5bf1046f004ee33a200ee497dc7593a5687/codex-rs/core/src/agent/control/residency.rs).

## Consequences for pi-dial

The user clarified that the priority is the same interface the Codex agent sees.
The next design should therefore start with the six native tool names, parameter
shapes, return values, role instructions and message envelopes. Do not invent a
separate supervisor-question protocol for the compatibility surface.

History inheritance, sender identity, wake rules, message ordering and delivery
boundaries are also part of that interface. A backend implementation can differ
internally while preserving these observable behaviors.

The highest-uncertainty experiment is whether our Codex requests can use native
`agent_message` inputs and the encrypted tool-argument schema successfully. A local
simulation can validate routing and replay, but cannot answer that backend question.
Keep any compatibility claim narrower than the experiments actually completed.
