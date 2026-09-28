import assert from "node:assert/strict";
import test from "node:test";
import { collaborationTools } from "../collaboration-tools.ts";
import { collaborationHistory } from "../collaboration.ts";
import { convertCollaborationPayload, createNativeCollaborationSidecar, putNativeFunctionCall, type CollaborationPayload } from "../collaboration-wire.ts";

test("the six reserved tools keep Codex's input schemas and encrypted message fields", () => {
	assert.deepEqual(collaborationTools.map(tool => tool.name), ["spawn_agent", "send_message", "followup_task", "wait_agent", "list_agents", "interrupt_agent"]);
	for (const name of ["spawn_agent", "send_message", "followup_task"]) {
		assert.equal((collaborationTools.find(tool => tool.name === name)!.parameters as any).properties.message.encrypted, true);
	}
	const wait = collaborationTools.find(tool => tool.name === "wait_agent")!;
	assert.equal((wait.parameters as any).properties.timeout_ms.type, "number", "The live backend rejects an integer schema for this reserved tool");
	assert.equal((wait.parameters as any).additionalProperties, false);
	assert.deepEqual(Object.keys((wait.parameters as any).properties), ["timeout_ms"]);
	assert.deepEqual(Object.keys((collaborationTools[0].parameters as any).properties), ["task_name", "message", "fork_turns"]);
});

test("fork keeps completed tool pairs but removes in-flight calls and orphaned results", () => {
	const history = collaborationHistory([
		{ role: "user", content: "work", timestamp: 0 },
		{ role: "assistant", content: [{ type: "toolCall", id: "finished", name: "read", arguments: {} }, { type: "toolCall", id: "pending", name: "spawn_agent", arguments: {} }] },
		{ role: "toolResult", toolCallId: "finished", toolName: "read", content: [{ type: "text", text: "done" }] },
		{ role: "toolResult", toolCallId: "orphan", toolName: "read", content: [{ type: "text", text: "unknown call" }] },
	] as any).flat();
	const assistant = history.find(message => message.role === "assistant")!;
	assert.deepEqual((assistant as any).content.map((part: any) => part.id), ["finished"]);
	assert.equal(history.filter(message => message.role === "toolResult").length, 1);
});

test("native replay preserves empty message success and JSON-encodes Pi errors for declared output schemas", () => {
	const sidecar = createNativeCollaborationSidecar();
	const makeCall = (name: string, id: string) => ({ type: "function_call" as const, name, namespace: "collaboration", id: `fc_${id}`, call_id: id, arguments: "{}", encrypted_function_args: [] });
	const send = makeCall("send_message", "send");
	const wait = makeCall("wait_agent", "wait");
	putNativeFunctionCall(sidecar, send); putNativeFunctionCall(sidecar, wait);
	const source = { input: [send, { type: "function_call_output", call_id: "send", output: "(no tool output)" },
		wait, { type: "function_call_output", call_id: "wait", output: "Tool execution was skipped" }] } satisfies CollaborationPayload;
	const restored = convertCollaborationPayload(source, sidecar);
	assert.deepEqual(restored.input, [send, { type: "function_call_output", call_id: "send", output: "" },
		wait, { type: "function_call_output", call_id: "wait", output: '{"error":"Tool execution was skipped"}' }]);
	assert.equal((source.input[3] as { output: string }).output, "Tool execution was skipped");
});
