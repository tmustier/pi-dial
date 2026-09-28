import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildOracleInput, serializeParentThread } from "../prompt.ts";

const extensionDir = join(import.meta.dirname, "..");

test("Oracle receives parent context without assistant thinking blocks", () => {
	const entries = [
		{
			type: "message",
			id: "one",
			parentId: null,
			timestamp: "2026-07-01T00:00:00.000Z",
			message: { role: "user", content: "Remember COBALT-731", timestamp: 1 },
		},
		{
			type: "message",
			id: "two",
			parentId: "one",
			timestamp: "2026-07-01T00:00:01.000Z",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "private chain", thinkingSignature: "sig" },
					{ type: "text", text: "I will remember it" },
				],
				api: "openai-responses",
				provider: "test",
				model: "test",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			},
		},
	] as SessionEntry[];
	const transcript = serializeParentThread(entries, 20_000);
	const input = buildOracleInput("What token did the user provide?", transcript);
	assert.match(input, /COBALT-731/);
	assert.match(input, /I will remember it/);
	assert.doesNotMatch(input, /private chain/);
	assert.match(input, /<oracle_task>/);
});

test("parent transcript truncation retains the newest content", () => {
	const entries = ["old-".repeat(50), "newest marker"].map(
		(content, index) =>
			({
				type: "message",
				id: String(index),
				parentId: index === 0 ? null : String(index - 1),
				timestamp: `2026-07-01T00:00:0${index}.000Z`,
				message: { role: "user", content, timestamp: index },
			}) as SessionEntry,
	);
	const transcript = serializeParentThread(entries, 100);
	assert.match(transcript, /earlier parent-thread content omitted/);
	assert.match(transcript, /newest marker/);
});
