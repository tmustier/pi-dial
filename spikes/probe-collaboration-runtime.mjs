#!/usr/bin/env node
/** Explicit live smoke: at most 12 requests, 120 seconds, collaboration tools only. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModels } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { installNativeCollaboration } from "../collaboration.ts";
import { createNativeCodexStream } from "../collaboration-stream.ts";
import piDialExtension from "../index.ts";
import { collaborationTools } from "../collaboration-tools.ts";

const deadline = AbortSignal.timeout(120_000);
const modelTemplate = getModels("openai-codex").find(model => model.api === "openai-codex-responses");
if (!modelTemplate) throw new Error("No OpenAI Codex Responses model is available as a probe template");
const model = { ...modelTemplate, id: "gpt-6-sol", name: "GPT-6 Sol" };
const dir = await mkdtemp(join(tmpdir(), "pi-dial-native-runtime-probe-"));
const automatic = process.argv.includes("--automatic");
if (automatic) {
	await mkdir(join(dir, ".pi"));
	await writeFile(join(dir, ".pi", "pi-dial.json"), JSON.stringify({ defaultMode: "high" }));
}
let requests = 0;
let nativeMessages = 0;
let encryptedMessages = 0;
let childQuestionObserved = false;
let parentReplyObserved = false;
let childFinalObserved = false;
const routes = new Set();
const boundedFetch = async (url, options) => {
	if (++requests > 12) throw new Error("Runtime probe request budget exceeded");
	const body = JSON.parse(options.body);
	for (const item of body.input) if (item.type === "agent_message") {
		nativeMessages++;
		if (item.content.some(part => part.type === "encrypted_content")) encryptedMessages++;
		const text = item.content.filter(part => part.type === "input_text").map(part => part.text).join("");
		routes.add(JSON.stringify({ author: item.author, recipient: item.recipient, kind: text.split("\n")[0], ...(text.includes("Agent errored:") ? { failure: text.slice(-800).replace(/[A-Za-z0-9_-]{60,}/g, "[redacted]") } : {}) }));
		if (item.author === "/root/probe" && item.recipient === "/root" && text.startsWith("Message Type: MESSAGE\n")) childQuestionObserved = true;
		if (item.author === "/root" && item.recipient === "/root/probe" && text.startsWith("Message Type: MESSAGE\n")) parentReplyObserved = true;
		if (item.author === "/root/probe" && item.recipient === "/root" && text.startsWith("Message Type: FINAL_ANSWER\n") && text.endsWith("CHILD_DONE_42")) childFinalObserved = true;
	}
	return fetch(url, { ...options, signal: AbortSignal.any([deadline, ...(options.signal ? [options.signal] : [])]) });
};
const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
	noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
	extensionFactories: [pi => { (automatic ? piDialExtension : installNativeCollaboration)(pi, {
		createStream: options => {
			const stream = createNativeCodexStream(options);
			return (model, context, streamOptions) => stream(model, context, { ...streamOptions, fetch: boundedFetch });
		},
	}); }],
});
let session;
try {
	await loader.reload();
	if (loader.getExtensions().errors.length) throw new Error("Extension load failed");
	const runtime = await ModelRuntime.create();
	for (const { name, config } of loader.getExtensions().runtime.pendingProviderRegistrations) runtime.registerProvider(name, config);
	loader.getExtensions().runtime.pendingProviderRegistrations = [];
	({ session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime,
		model, thinkingLevel: "minimal",
		resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(dir),
		tools: collaborationTools.map(tool => tool.name),
	}));
	const errors = [];
	await session.bindExtensions({ onError: () => { errors.push("Extension error"); } });
	const abort = () => void session.abort();
	deadline.addEventListener("abort", abort, { once: true });
	try {
		await session.prompt(`This is a bounded agent-messaging smoke test, not coding work. Follow this exact protocol:
1. Spawn one child named probe, fork_turns all. Its task: send_message to /root with message QUESTION; wait for the parent's reply; once it receives ANSWER_42, finish with final answer CHILD_DONE_42. It must not spawn any agents.
2. Wait for QUESTION from the child, then send_message to probe with message ANSWER_42.
3. Wait for its FINAL_ANSWER CHILD_DONE_42. Only then finish with exactly NATIVE_RUNTIME_OK.
The send_message calls in both directions are the behavior under test. Mentioning ANSWER_42 in inherited context does not count as receiving a reply. Tell the child it MUST send QUESTION even though it has inherited these instructions and already knows the answer text; it must wait for an actual native MESSAGE reply before returning its final answer. Finishing early or guessing is a failed test.
Use collaboration tools only. Do not send any other messages or create any other agents.`);
	} finally { deadline.removeEventListener("abort", abort); }
	const last = [...session.agent.state.messages].reverse().find(message => message.role === "assistant");
	const text = last?.content.filter(part => part.type === "text").map(part => part.text).join("\n").trim();
	const success = text === "NATIVE_RUNTIME_OK" && !errors.length && encryptedMessages > 0 && childQuestionObserved && parentReplyObserved && childFinalObserved;
	console.log(JSON.stringify({ success, automatic, requests, nativeMessageOccurrences: nativeMessages,
		encryptedMessageOccurrences: encryptedMessages, childQuestionObserved, parentReplyObserved, childFinalObserved,
		finalExact: text === "NATIVE_RUNTIME_OK", stopReason: last?.stopReason,
		extensionErrors: errors.length,
		...(!success ? { observedRoutes: [...routes].map(route => JSON.parse(route)), finalText: text?.replace(/[A-Za-z0-9_-]{60,}/g, "[redacted]").slice(0, 500) } : {}),
		...(last?.errorMessage ? { error: last.errorMessage.replace(/[A-Za-z0-9_-]{60,}/g, "[redacted]").slice(0, 1000) } : {}) }, null, 2));
	process.exitCode = success ? 0 : 1;
} catch (error) {
	console.log(JSON.stringify({ success: false, requests, stage: "runtime", error: error instanceof Error ? error.message : String(error) }, null, 2));
	process.exitCode = 1;
} finally {
	await session?.abort();
	await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	session?.dispose();
	await rm(dir, { recursive: true, force: true });
}
