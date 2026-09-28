import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { createNativeCodexStream } from "../collaboration-stream.ts";
import { createNativeCollaborationSidecar, nativeFunctionCallKey, putNativeAgentMessage, type NativeFunctionCallRecord } from "../collaboration-wire.ts";
import { collaborationTools } from "../collaboration-tools.ts";
import { gpt6SolModel } from "./model-fixture.ts";

const model = { ...gpt6SolModel(), baseUrl: "https://example.test/backend-api", thinkingLevelMap: { minimal: "low" } };
const apiKey = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" } })).toString("base64url")}.x`;

function sse(events: unknown[]): Response {
	return new Response(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

test("captures raw native calls before Pi normalization and namespaces the six tools", async () => {
	const sidecar = createNativeCollaborationSidecar();
	let requestBody: any;
	const rawCalls: NativeFunctionCallRecord[] = [undefined, [], ["message"]].map((encrypted, index) => ({
		type: "function_call", id: `fc_${index}`, call_id: `call_${index}`, name: "send_message", namespace: "collaboration",
		arguments: `{ "target": "/root/child", "message": "payload_${index}" }`,
		...(encrypted === undefined ? {} : { encrypted_function_args: encrypted }),
		internal_chat_message_metadata_passthrough: { parent: "/root" },
	}));
	const fakeFetch: typeof fetch = async (_url, init) => {
		requestBody = JSON.parse(String(init?.body));
		assert.equal(new Headers(init?.headers).get("accept"), "text/event-stream");
		return sse([
			...rawCalls.flatMap((item, output_index) => [
				{ type: "response.output_item.added", output_index, item: { ...item, arguments: "" } },
				{ type: "response.output_item.done", output_index, item: { ...item, status: "completed" } },
			]),
			{ type: "response.done", response: { status: "completed", output: rawCalls, usage: {} } },
		]);
	};
	const tools = [...collaborationTools, { name: "read", description: "ordinary", parameters: { type: "object", properties: {} } }];
	const result = await createNativeCodexStream({ sidecar })(model, normalizeContext({ messages: [], tools }), { apiKey, reasoning: "minimal", fetch: fakeFetch }).result();

	assert.deepEqual(requestBody.tools.find((tool: any) => tool.type === "namespace").tools.map((tool: any) => tool.name), collaborationTools.map(tool => tool.name));
	assert.equal(requestBody.tools.find((tool: any) => tool.name === "read").type, "function");
	assert.equal(requestBody.reasoning.effort, "low");
	for (const item of rawCalls) assert.deepEqual(sidecar.functionCalls.get(nativeFunctionCallKey(item.call_id, item.id)), item);
	assert.equal(result.stopReason, "toolUse");
	assert.deepEqual(result.content.filter(part => part.type === "toolCall").map(part => part.namespace), ["collaboration", "collaboration", "collaboration"]);
});

test("restores native inputs before invoking Pi's payload hook", async () => {
	const sidecar = createNativeCollaborationSidecar();
	const message = { type: "agent_message" as const, author: "/root/child", recipient: "/root", content: [{ type: "input_text" as const, text: "done" }] };
	putNativeAgentMessage(sidecar, "host-marker", message);
	const delivered: string[] = [];
	const stream = createNativeCodexStream({ sidecar, onAgentMessageRestored: marker => { delivered.push(marker); } });
	const result = await stream(model, normalizeContext({ messages: [{ role: "user", content: "host-marker", timestamp: 0 }] }), {
		apiKey,
		onPayload(payload) {
			assert.deepEqual((payload as any).input, [message]);
			assert.deepEqual(delivered, ["host-marker"]);
			return { ...(payload as object), hookRan: true };
		},
		fetch: async (_url, init) => {
			assert.equal(JSON.parse(String(init?.body)).hookRan, true);
			return sse([{ type: "response.completed", response: { status: "completed", output: [], usage: {} } }]);
		},
	}).result();
	assert.equal(result.stopReason, "stop");
});

test("HTTP errors, malformed JSON and truncated streams become terminal errors", async () => {
	for (const [response, error] of [
		[new Response(JSON.stringify({ error: { message: "safe failure" } }), { status: 400 }), /safe failure/],
		[new Response("data: {not-json}\n\n"), /Invalid Codex SSE JSON/],
		[sse([{ type: "response.created", response: { id: "r" } }]), /ended before a terminal response/],
	] as const) {
		const result = await createNativeCodexStream({ sidecar: createNativeCollaborationSidecar() })(model, normalizeContext({ messages: [] }), { apiKey, fetch: async () => response }).result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage!, error);
	}
});

test("abort cancels a pending SSE reader", { timeout: 1000 }, async () => {
	const controller = new AbortController();
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		start(streamController) { streamController.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"r"}}\n\n')); },
		cancel() { cancelled = true; },
	});
	const pending = createNativeCodexStream({ sidecar: createNativeCollaborationSidecar() })(model, normalizeContext({ messages: [] }), {
		apiKey, signal: controller.signal, fetch: async () => new Response(body),
	}).result();
	setTimeout(() => controller.abort(), 5);
	const result = await pending;
	assert.equal(result.stopReason, "aborted");
	assert.equal(cancelled, true);
});
