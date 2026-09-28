import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { createNativeCodexStream } from "../collaboration-stream.ts";
import { createNativeCollaborationSidecar } from "../collaboration-wire.ts";
import { gpt6SolModel } from "./model-fixture.ts";
const model = gpt6SolModel();
const apiKey = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64url")}.x`;
const reasoning = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Working" }], encrypted_content: "opaque" };
const final = { type: "message", id: "msg_1", phase: "final_answer", content: [{ type: "output_text", text: "Finished" }] };
const itemEvents = (item: unknown, output_index: number) => [
	{ type: "response.output_item.added", output_index, item },
	{ type: "response.output_item.done", output_index, item },
];
const terminal = { type: "response.completed", response: { status: "completed", output: [], usage: {} } };

test("mail yields after a whole reasoning item, cancels the current reader, and does not sample final text", async () => {
	let cancelled = false;
	const phases: string[] = [];
	const body = new ReadableStream({
		start(controller) { controller.enqueue(new TextEncoder().encode([...itemEvents(reasoning, 0), ...itemEvents(final, 1), terminal]
			.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""))); },
		cancel() { cancelled = true; },
	});
	const stream = createNativeCodexStream({ sidecar: createNativeCollaborationSidecar(),
		onResponsePhase: phase => { phases.push(phase); }, yieldAtMessageBoundary: () => true,
	});
	const result = await stream(model, normalizeContext({ messages: [] }), { apiKey, fetch: async () => new Response(body) }).result();
	assert.equal(result.stopReason, "stop");
	assert.equal(result.content.filter(item => item.type === "thinking").length, 1);
	assert.equal(result.content.filter(item => item.type === "text").length, 0);
	assert.deepEqual(phases, ["sampling", "idle"]);
	assert.equal(cancelled, true);
});

test("does not yield while an interleaved tool call is incomplete", async () => {
	let checks = 0;
	const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "wait_agent", namespace: "collaboration", arguments: "{}" };
	const events = [
		{ type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
		...itemEvents(reasoning, 1),
		{ type: "response.output_item.done", output_index: 0, item: call },
		...itemEvents(final, 2), terminal,
	];
	const stream = createNativeCodexStream({ sidecar: createNativeCollaborationSidecar(),
		yieldAtMessageBoundary() { checks++; return true; },
	});
	const result = await stream(model, normalizeContext({ messages: [] }), { apiKey,
		fetch: async () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")),
	}).result();
	assert.notEqual(result.stopReason, "error");
	assert.equal(checks, 0);
	assert.equal(result.content.find(item => item.type === "text")?.text, "Finished");
});

test("announces the final-answer phase before emitting its text", async () => {
	const trace: string[] = [];
	const stream = createNativeCodexStream({ sidecar: createNativeCollaborationSidecar(),
		onResponsePhase: phase => { trace.push(phase); },
	});
	for await (const event of stream(model, normalizeContext({ messages: [] }), { apiKey,
		fetch: async () => new Response([...itemEvents(final, 0), terminal].map(event => `data: ${JSON.stringify(event)}\n\n`).join("")),
	})) trace.push(event.type);
	assert.ok(trace.indexOf("final") >= 0 && trace.indexOf("final") < trace.indexOf("text_start"));
});
