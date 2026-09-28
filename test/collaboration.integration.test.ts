import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { installNativeCollaboration, collaborationHistory } from "../collaboration.ts";
import { createNativeCodexStream } from "../collaboration-stream.ts";
import piDialExtension from "../index.ts";
import { gpt6SolModel } from "./model-fixture.ts";

const apiKey = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64url")}.x`;
const reply = (items: any[]) => new Response([
	...items.flatMap((item, output_index) => [
		{ type: "response.output_item.added", output_index, item: { ...item, ...(item.type === "function_call" ? { arguments: "" } : {}) } },
		{ type: "response.output_item.done", output_index, item },
	]),
	{ type: "response.completed", response: { id: "response_test", status: "completed", output: items, usage: {} } },
].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
for (const automatic of [false, true]) for (const encrypted of [false, true]) test(`real Pi SDK ${automatic ? "automatic high" : "standalone"} sessions exchange ${encrypted ? "encrypted" : "plaintext"} mail and reuse an idle child (no network)`, { timeout: 15_000 }, async () => {
	let sequence = 0;
	let messageCalls = 0;
	const tool = (name: string, args: Record<string, unknown>) => {
		const hasMessage = typeof args.message === "string";
		const flag = encrypted && hasMessage ? (++messageCalls % 2 ? undefined : ["message"]) : [];
		return { type: "function_call", id: `fc_${++sequence}`, call_id: `call_${sequence}`, name, namespace: "collaboration",
			arguments: JSON.stringify(encrypted && hasMessage ? { ...args, message: `opaque:${args.message}` } : args),
			...(flag === undefined ? {} : { encrypted_function_args: flag }),
		};
	};
	const final = (text: string) => ({ type: "message", id: `msg_${++sequence}`, role: "assistant", phase: "final_answer", content: [{ type: "output_text", text }] });
	const messageText = (item: any) => item.content.map((part: any) => part.type === "encrypted_content" ? part.encrypted_content.slice("opaque:".length) : part.text).join("");
	const dir = await mkdtemp(join(tmpdir(), "pi-dial-collaboration-test-"));
	if (automatic) {
		await mkdir(join(dir, ".pi"));
		await writeFile(join(dir, ".pi", "pi-dial.json"), JSON.stringify({
			defaultMode: "high",
			modes: {
				high: { model: "openai-codex/gpt-6-astra", thinking: "minimal" },
				medium: { model: "openai-codex/gpt-6-astra", thinking: "medium" },
			},
		}));
	}
	const payloads: any[] = [];
	let replayOnly = false;
	const fakeFetch: typeof fetch = async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		payloads.push(body);
		assert.ok(payloads.length <= 24, "Unexpected model-loop spin");
		if (replayOnly) {
			assert.ok(!body.tools.some((item: any) => item.type === "namespace" && item.name === "collaboration"));
			assert.ok(!body.instructions.includes("Your canonical task name is /root."));
			assert.ok(body.input.some((item: any) => item.type === "agent_message"));
			assert.ok(!JSON.stringify(body.input).includes("[pi-dial-native:"));
			assert.ok(body.input.filter((item: any) => item.type === "function_call" && item.name === "spawn_agent").every((item: any) => item.namespace === "collaboration"));
			return reply([final("REPLAY_OK")]);
		}
		const collaboration = body.tools.filter((item: any) => item.type === "namespace" && item.name === "collaboration");
		assert.equal(collaboration.length, 1);
		assert.deepEqual(collaboration[0].tools.map((item: any) => item.name).sort(),
			["spawn_agent", "send_message", "followup_task", "wait_agent", "list_agents", "interrupt_agent"].sort());
		assert.ok(!JSON.stringify(body.input).includes("[pi-dial-native:"), "Host markers must never reach the backend");
		for (const call of body.input.filter((item: any) => item.type === "function_call")) {
			const output = body.input.find((item: any) => item.type === "function_call_output" && item.call_id === call.call_id);
			assert.ok(output, `Dangling function call in fork/replay: ${call.call_id}`);
			if (["send_message", "followup_task"].includes(call.name) && output.output !== "No result provided") assert.equal(output.output, "", "Codex success is empty, not Pi's placeholder");
		}
		const child = body.instructions.includes("Your canonical task name is /root/solver.");
		const grandchild = body.instructions.includes("Your canonical task name is /root/solver/nested.");
		const messages = body.input.filter((item: any) => item.type === "agent_message");
		for (const message of messages) {
			if (/^Message Type: (NEW_TASK|MESSAGE)\n/.test(message.content[0].text)) {
				assert.equal(message.content.length, encrypted ? 2 : 1);
				if (encrypted) {
					assert.equal(message.content[1].type, "encrypted_content");
					assert.match(message.content[1].encrypted_content, /^opaque:/);
				}
			}
		}
		const text = messages.map(messageText).join("\n");
		if (grandchild) {
			assert.equal(messages.filter((message: any) => message.content[0].text.startsWith("Message Type: NEW_TASK\n")).length, 1,
				"A nested child receives only its own assignment");
			assert.ok(text.includes("Solve nested task"));
			assert.ok(!text.includes("Ask for an answer then finish"));
			return reply([final("GRANDCHILD_DONE")]);
		}
		if (child) {
			assert.equal(body.instructions.split("Your canonical task name is /root/solver.").length - 1, 1);
			const inheritedInstruction = "You are an expert coding assistant operating inside pi";
			assert.equal(body.instructions.split(inheritedInstruction).length - 1, 1);
			assert.ok(body.instructions.includes("Your parent is /root."));
			if (text.includes("FOLLOWUP")) {
				assert.ok(text.indexOf("NOTE_LATE") < text.indexOf("FOLLOWUP"), "Idle mail precedes the new assignment");
				assert.ok(text.includes("ANSWER_42"), "Follow-up retains the child's own conversation");
				return reply([final("FOLLOWUP_DONE")]);
			}
			if (text.includes("GRANDCHILD_DONE")) return reply([final("CHILD_DONE_42")]);
			return text.includes("ANSWER_42")
				? reply([tool("spawn_agent", { task_name: "nested", message: "Solve nested task", fork_turns: "all" }), tool("wait_agent", {})])
				: reply([tool("send_message", { target: "/root", message: "QUESTION" }), tool("wait_agent", {})]);
		}
		const lastUserIndex = body.input.findLastIndex((item: any) => item.role === "user");
		const userText = JSON.stringify(body.input[lastUserIndex]);
		if (userText.includes("Queue a note")) {
			return body.input.slice(lastUserIndex).some((item: any) => item.type === "function_call" && item.name === "send_message")
				? reply([final("QUEUED")]) : reply([tool("send_message", { target: "solver", message: "NOTE_LATE" })]);
		}
		if (userText.includes("Continue worker")) {
			return text.includes("FOLLOWUP_DONE") ? reply([final("REUSED_DONE")])
				: reply([tool("followup_task", { target: "solver", message: "FOLLOWUP" }), tool("wait_agent", {})]);
		}
		if (text.includes("CHILD_DONE_42")) return reply([final("ROOT_DONE")]);
		if (text.includes("QUESTION")) return reply([tool("send_message", { target: "solver", message: "ANSWER_42" }), tool("wait_agent", {})]);
		return reply([tool("spawn_agent", { task_name: "solver", message: "Ask for an answer then finish", fork_turns: "all" }), tool("wait_agent", {})]);
	};
	const createModelRuntime = async () => {
		const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") });
		runtime.registerProvider("openai-codex", { apiKey });
		return runtime;
	};
	const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
		noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
		extensionFactories: [pi => { (automatic ? piDialExtension : installNativeCollaboration)(pi, { createModelRuntime,
			createStream: options => {
				const stream = createNativeCodexStream(options);
				return (model, context, requestOptions) => stream(model, context, { ...requestOptions, fetch: fakeFetch });
			},
		}); }],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const rootRuntime = await createModelRuntime();
	for (const { name, config } of loader.getExtensions().runtime.pendingProviderRegistrations) rootRuntime.registerProvider(name, config);
	loader.getExtensions().runtime.pendingProviderRegistrations = [];
	const { session } = await createAgentSession({ cwd: dir, agentDir: dir,
		model: { ...gpt6SolModel(), baseUrl: "http://127.0.0.1:9" }, modelRuntime: rootRuntime,
		thinkingLevel: "minimal", resourceLoader: loader, settingsManager: settings,
		sessionManager: SessionManager.inMemory(dir), noTools: "builtin",
	});
	const errors: string[] = [];
	await session.bindExtensions({ onError: error => { errors.push(String(error)); } });
	const abort = setTimeout(() => void session.abort(), 12_000);
	try {
		await session.prompt("Exercise the parent-child exchange.");
		const texts = session.agent.state.messages.filter(message => message.role === "assistant")
			.flatMap(message => message.content.filter(part => part.type === "text").map(part => part.text));
		assert.equal(texts.at(-1), "ROOT_DONE", JSON.stringify(session.agent.state.messages.slice(-4)));
		assert.deepEqual(errors, []);
		assert.ok(payloads.some(body => body.input.some((item: any) => item.type === "agent_message" && item.author === "/root/solver" && item.recipient === "/root")));
		const childPayloads = payloads.filter(body => body.instructions.includes("Your canonical task name is /root/solver."));
		assert.ok(childPayloads[0].input.some((item: any) => item.role === "user"), "all fork inherits the parent user turn");
		assert.ok(childPayloads.at(-1).input.some((item: any) => item.type === "agent_message" && messageText(item).includes("ANSWER_42")));
		await session.prompt("Queue a note without waking the finished child.");
		assert.equal(payloads.filter(body => body.instructions.includes("Your canonical task name is /root/solver.")).length, childPayloads.length);
		await session.prompt("Continue worker on a follow-up task.");
		const last = [...session.agent.state.messages].reverse().find(message => message.role === "assistant");
		assert.equal(last?.content.find(part => part.type === "text")?.text, "REUSED_DONE");
		assert.deepEqual(errors, []);
		if (automatic) {
			await session.prompt("/dial medium");
			assert.ok(!session.getActiveToolNames().includes("spawn_agent"));
			assert.ok(session.getActiveToolNames().includes("oracle"));
			assert.ok(session.getActiveToolNames().includes("Task"));
			replayOnly = true;
			await session.prompt("Continue without collaboration.");
			const last = [...session.agent.state.messages].reverse().find(message => message.role === "assistant");
			assert.equal(last?.content.find(part => part.type === "text")?.text, "REPLAY_OK");
			assert.deepEqual(errors, []);
		}
	} finally {
		clearTimeout(abort);
		await session.abort();
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
		await rm(dir, { recursive: true, force: true });
	}
});

test("history counts user turns, removes system state and agent mail, and does not share mutable message objects", () => {
	const messages: any[] = [{ role: "system", content: "parent instructions", timestamp: 0 },
		{ role: "user", content: "one", timestamp: 0 },
		{ role: "custom", customType: "pi-dial-agent-message", content: "mail", timestamp: 0 },
		{ role: "user", content: "two", timestamp: 1 }];
	const history = collaborationHistory(messages);
	assert.equal(history.length, 2);
	assert.equal(history[0].length, 1);
	messages[1].content = "changed";
	assert.equal((history[0][0] as any).content, "one");
});
