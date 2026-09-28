import assert from "node:assert/strict";
import test from "node:test";
import { convertCollaborationPayload, createNativeCollaborationSidecar, putNativeAgentMessage, putNativeFunctionCall, type NativeAgentMessageRecord, type NativeFunctionCallRecord } from "../collaboration-wire.ts";

const marker = "[pi-dial-native:host-random-1]";
const message: NativeAgentMessageRecord = {
	type: "agent_message", id: "amsg_1", author: "/root/review", recipient: "/root",
	content: [{ type: "input_text", text: "Message Type: MESSAGE\nPayload:\nreview done" }],
	internal_chat_message_metadata_passthrough: { turn_id: "turn_1" },
};
const user = (text: string) => ({ role: "user" as const, content: [{ type: "input_text" as const, text }] });

test("converts only a standalone marker registered by the host", () => {
	const sidecar = createNativeCollaborationSidecar();
	putNativeAgentMessage(sidecar, marker, message);
	const ordinary = [user(`${marker} please`), { role: "user" as const, content: [...user(marker).content, ...user("x").content] },
		user("[pi-dial-native:unregistered]"), user("constructor"), user("__proto__")];
	const source = { input: [...ordinary, user(marker)] };
	assert.deepEqual(convertCollaborationPayload(source, sidecar).input, [...ordinary, message]);
	assert.deepEqual(source.input.at(-1), user(marker));
});

test("restores raw calls without re-encoding arguments or losing encryption metadata", () => {
	const sidecar = createNativeCollaborationSidecar();
	const calls: NativeFunctionCallRecord[] = [undefined, [], ["message"]].map((encrypted, index) => ({
		type: "function_call", id: `fc_${index}`, call_id: `call_${index}`, name: "send_message", namespace: "collaboration",
		arguments: '{ "target": "/root/review", "message": "payload" }',
		...(encrypted === undefined ? {} : { encrypted_function_args: encrypted }),
		internal_chat_message_metadata_passthrough: { turn_id: "turn_2" },
	}));
	for (const call of calls) putNativeFunctionCall(sidecar, call);
	const input = calls.map(call => ({ type: call.type, id: call.id, call_id: call.call_id, name: call.name, arguments: JSON.stringify(JSON.parse(call.arguments)) }));
	assert.deepEqual(convertCollaborationPayload({ input }, sidecar).input, calls);
});
