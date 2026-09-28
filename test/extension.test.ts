import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSession,
	DefaultResourceLoader,
	initTheme,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ProviderConfig,
	type SessionEntry,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import piDialExtension from "../index.ts";
import { collaborationTools } from "../collaboration-tools.ts";
import { gpt6SolModel } from "./model-fixture.ts";
const nativeTools: string[] = collaborationTools.map(tool => tool.name);

interface RegisteredCommand {
	handler: (args: string, ctx: ExtensionContext) => void | Promise<void>;
}

interface RegisteredShortcut {
	handler: (ctx: ExtensionContext) => void | Promise<void>;
}

interface HudComponent {
	render(width: number): string[];
	handleInput?(data: string): void;
}

interface ToolResultLike {
	content: Array<{ type: string; text: string }>;
	details?: {
		kind: string;
		mode: string;
		model?: string;
		thinking?: string;
		selectionSource?: string;
		usedFallback?: boolean;
		run?: { artifacts?: { metaPath?: string } };
	};
	isError?: boolean;
}

interface RegisteredToolLike {
	name: string;
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters?: { properties?: Record<string, { enum?: string[] }> };
	renderCall?: (args: Record<string, unknown>, theme: Theme, context: unknown) => HudComponent;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate: ((update: { content: Array<{ type: string; text: string }> }) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<ToolResultLike>;
}

interface Harness {
	ctx: ExtensionContext;
	providers: Map<string, ProviderConfig>;
	commands: Map<string, RegisteredCommand>;
	shortcuts: Map<string, RegisteredShortcut>;
	emit: (event: string, payload?: unknown) => Promise<unknown[]>;
	setIdle: (idle: boolean) => void;
	selected: () => { model?: string; thinking?: string; tools: string[] };
	notifications: Array<{ message: string; level: string }>;
	observerRequests: Array<{ model: string; prompt: string; reasoningEffort: string | undefined }>;
	entries: SessionEntry[];
	hud: () => HudComponent | undefined;
	editorText: () => string;
	tool: (name: string) => RegisteredToolLike;
	setExternalModel: (provider: string, id: string, thinking: string) => Promise<void>;
}

function deferredSignal(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

function fakeModel(provider: string, id: string): Model<Api> {
	return {
		provider,
		id,
		name: id,
		api: provider === "openai-codex" ? "openai-codex-responses" : "openai-responses",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 16_000,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
	} as Model<Api>;
}

function createHarness(
	cwd: string,
	initialEntries: SessionEntry[] = [],
	{
		rejectedProviders = new Set<string>(),
		unavailableModels = new Set<string>(),
		unauthenticatedModels = new Set<string>(),
		beforeSetModel,
	}: {
		rejectedProviders?: ReadonlySet<string>;
		unavailableModels?: ReadonlySet<string>;
		unauthenticatedModels?: ReadonlySet<string>;
		beforeSetModel?: (model: Model<Api>) => Promise<void>;
	} = {},
): Harness {
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const commands = new Map<string, RegisteredCommand>();
	const registeredTools = new Map<string, RegisteredToolLike>();
	const entries = [...initialEntries];
	const models = [
		fakeModel("radius", "glm-5.2"),
		fakeModel("openrouter", "z-ai/glm-5.2"),
		{
			...fakeModel("cursor", "glm-5.2"),
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: null,
				medium: null,
				high: "high",
				xhigh: null,
				max: "max",
			},
		} as Model<Api>,
		fakeModel("openai-codex", "gpt-6-sol"),
		fakeModel("openai-codex", "gpt-6-astra"),
		fakeModel("openai-codex", "gpt-5.6-luna"),
		fakeModel("anthropic", "claude-opus-5-5"),
		fakeModel("anthropic", "claude-fable-5-1"),
		fakeModel("example", "worker-v2"),
		fakeModel("example", "reviewer-v3"),
	];
	let idle = true;
	let selectedModel: Model<Api> | undefined;
	let selectedThinking: string | undefined;
	let hudComponent: HudComponent | undefined;
	let editorText = "";
	const providers = new Map<string, ProviderConfig>();
	const activeTools = [
		"read",
		"bash",
		"edit",
		"write",
		"oracle",
		"Task",
		"pinet",
		"slack",
		"slack_inbox",
		"slack_send",
		"future_extension_tool",
	];
	const notifications: Array<{ message: string; level: string }> = [];
	const observerRequests: Harness["observerRequests"] = [];
	const shortcuts = new Map<string, RegisteredShortcut>();
	let ctx: ExtensionContext;

	const api = {
		registerProvider(name: string, config: ProviderConfig) { providers.set(name, { ...providers.get(name), ...config }); },
		unregisterProvider(name: string) { providers.delete(name); },
		registerFlag() {},
		getFlag() {
			return undefined;
		},
		registerCommand(name: string, command: RegisteredCommand) {
			commands.set(name, command);
		},
		registerShortcut(key: string, shortcut: RegisteredShortcut) {
			shortcuts.set(key, shortcut);
		},
		registerTool(tool: RegisteredToolLike) {
			registeredTools.set(tool.name, tool);
			if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
		},
		on(event: string, handler: (...args: unknown[]) => unknown) {
			const current = handlers.get(event) ?? [];
			current.push(handler);
			handlers.set(event, current);
		},
		async setModel(model: Model<Api>) {
			await beforeSetModel?.(model);
			if (rejectedProviders.has(model.provider)) return false;
			selectedModel = model;
			for (const handler of handlers.get("model_select") ?? []) {
				handler({ model, previousModel: undefined, source: "extension" }, ctx);
			}
			return true;
		},
		setThinkingLevel(level: string) {
			selectedThinking = level;
			for (const handler of handlers.get("thinking_level_select") ?? []) {
				handler({ level, previousLevel: "off" }, ctx);
			}
		},
		getThinkingLevel() {
			return selectedThinking ?? "off";
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(tools: string[]) {
			assert.deepEqual(tools.filter(tool => !nativeTools.includes(tool)), activeTools.filter(tool => !nativeTools.includes(tool)),
				"pi-dial must not modify tools owned by Pi or other extensions (issue #1)");
			activeTools.splice(0, activeTools.length, ...tools);
		},
		getAllTools() {
			return activeTools.map((name) => ({ name }));
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({
				type: "custom",
				customType,
				data,
				id: `entry-${entries.length}`,
				parentId: entries.at(-1)?.id ?? null,
				timestamp: new Date().toISOString(),
			});
		},
	} as unknown as ExtensionAPI;

	const sessionManager = {
		getBranch: () => entries,
		buildContextEntries: () => entries,
	} as ExtensionContext["sessionManager"];
	ctx = {
		cwd,
		hasUI: true,
		ui: {
			setStatus() {},
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
			select: async () => undefined,
			theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
			getEditorText: () => editorText,
			setEditorText(text: string) {
				editorText = text;
			},
			custom: <T>(
				factory: (
					tui: { requestRender: () => void },
					theme: { fg: (color: string, text: string) => string; bold: (text: string) => string },
					keybindings: Record<string, never>,
					done: (result: T) => void,
				) => HudComponent,
			) =>
				new Promise<T>((resolveCustom) => {
					hudComponent = factory(
						{ requestRender: () => {} },
						{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
						{},
						(result: T) => {
							hudComponent = undefined;
							resolveCustom(result);
						},
					);
				}),
		},
		get model() {
			return selectedModel;
		},
		modelRegistry: {
			async complete(model: Model<Api>, context: { messages: Array<{ content: Array<{ text: string }> }> }, options: { reasoningEffort?: string }) {
				observerRequests.push({
					model: `${model.provider}/${model.id}`,
					prompt: context.messages.at(-1)?.content[0]?.text ?? "",
					reasoningEffort: options.reasoningEffort,
				});
				return { role: "assistant", content: [{ type: "text", text: "Observer summary" }] };
			},
			getRegisteredProviderConfig: (name: string) => providers.get(name),
			find: (provider: string, modelId: string) =>
				unavailableModels.has(`${provider}/${modelId}`)
					? undefined
					: models.find((model) => model.provider === provider && model.id === modelId),
			hasConfiguredAuth: (model: Model<Api>) =>
				!rejectedProviders.has(model.provider) && !unauthenticatedModels.has(`${model.provider}/${model.id}`),
		},
		sessionManager,
		settingsManager: {},
		resourceLoader: {},
		isIdle: () => idle,
		abort() {},
		shutdown() {},
		getContextUsage: () => undefined,
		compact: async () => undefined,
		getSystemPrompt: () => "",
	} as unknown as ExtensionContext;

	piDialExtension(api);
	return {
		ctx,
		providers,
		commands,
		shortcuts,
		emit: async (event, payload = {}) => {
			const results: unknown[] = [];
			for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
			return results;
		},
		setIdle: (value) => {
			idle = value;
		},
		selected: () => ({
			model: selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : undefined,
			thinking: selectedThinking,
			tools: [...activeTools],
		}),
		notifications,
		observerRequests,
		entries,
		hud: () => hudComponent,
		editorText: () => editorText,
		tool: (name) => {
			const tool = registeredTools.get(name);
			if (!tool) throw new Error(`Tool not registered: ${name}`);
			return tool;
		},
		setExternalModel: async (provider, id, thinking) => {
			const model = models.find((entry) => entry.provider === provider && entry.id === id) ?? fakeModel(provider, id);
			selectedModel = model;
			selectedThinking = thinking;
			for (const handler of handlers.get("model_select") ?? []) {
				await handler({ model, previousModel: undefined, source: "set" }, ctx);
			}
			for (const handler of handlers.get("thinking_level_select") ?? []) {
				await handler({ level: thinking, previousLevel: "off" }, ctx);
			}
		},
	};
}

test("all four presets switch model and thinking without replacing Pi's default prompt or tools", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-dial-extension-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	try {
		const harness = createHarness(cwd);
		await harness.emit("session_start");
		const dial = harness.commands.get("dial");
		assert.ok(dial);
		const [promptResult] = await harness.emit("before_agent_start", {
			prompt: "test",
			systemPrompt: "original",
			systemPromptOptions: { cwd },
		});
		assert.equal(promptResult, undefined);

		const expected = {
			low: ["anthropic/claude-opus-5-5", "medium"],
			medium: ["openai-codex/gpt-6-sol", "medium"],
			high: ["openai-codex/gpt-6-sol", "xhigh"],
			ultra: ["anthropic/claude-fable-5-1", "high"],
		};
		const originalTools = harness.selected().tools;
		for (const [mode, [model, thinking]] of Object.entries(expected)) {
			await dial.handler(mode, harness.ctx);
			assert.equal(harness.selected().model, model);
			assert.equal(harness.selected().thinking, thinking);
			assert.deepEqual(harness.selected().tools, mode === "high" ? [...originalTools, ...nativeTools] : originalTools);
		}
	} finally {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("inside an Oracle or Task child, Pi Dial registers nothing", () => {
	const oldDialChild = process.env.PI_DIAL_CHILD;
	process.env.PI_DIAL_CHILD = "1";
	try {
		const registered: string[] = [];
		const api = new Proxy({}, { get: (_target, name) => () => { registered.push(String(name)); } }) as unknown as ExtensionAPI;
		piDialExtension(api);
		assert.deepEqual(registered, []);
	} finally {
		if (oldDialChild === undefined) delete process.env.PI_DIAL_CHILD;
		else process.env.PI_DIAL_CHILD = oldDialChild;
	}
});

test("Pi Dial registers Wut and its observer reads the active session without changing the dial", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-dial-wut-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const oldLog = console.log;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	try {
		const harness = createHarness(cwd);
		await harness.emit("session_start");
		const command = harness.commands.get("wut");
		assert.ok(command);
		const before = harness.selected();
		harness.entries.push({
			type: "message", id: "user-wut", parentId: null, timestamp: new Date().toISOString(),
			message: { role: "user", content: [{ type: "text", text: "Fix the parser" }], timestamp: Date.now() },
		} as SessionEntry);
		const output: string[] = [];
		console.log = (line: string) => { output.push(line); };
		const ctx = { ...harness.ctx, mode: "print", hasUI: false } as ExtensionCommandContext;
		await command.handler("What happened?", ctx);
		assert.deepEqual(output, ["Observer summary"]);
		assert.deepEqual(harness.observerRequests.map(({ model, reasoningEffort }) => [model, reasoningEffort]), [
			["openai-codex/gpt-5.6-luna", "low"],
		]);
		assert.match(harness.observerRequests[0].prompt, /Fix the parser/);
		assert.match(harness.observerRequests[0].prompt, /What happened\?/);
		await command.handler("auto off", ctx);
		assert.equal(output.at(-1), "wut watchdog OFF");
		assert.deepEqual(harness.selected(), before);
	} finally {
		console.log = oldLog;
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Wut falls back to the session model when Luna is registered but unauthenticated", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-dial-wut-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const oldLog = console.log;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	try {
		const harness = createHarness(cwd, [], { unauthenticatedModels: new Set(["openai-codex/gpt-5.6-luna"]) });
		await harness.emit("session_start");
		const command = harness.commands.get("wut");
		assert.ok(command);
		console.log = () => {};
		await command.handler("What happened?", { ...harness.ctx, mode: "print", hasUI: false } as ExtensionCommandContext);
		assert.deepEqual(harness.observerRequests.map(({ model }) => model), ["openai-codex/gpt-6-sol"]);
	} finally {
		console.log = oldLog;
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("high owns only native tools, preserves Oracle/Task, and restores provider ownership on deactivate/reload", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-dial-auto-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const oldChildCommand = process.env.PI_DIAL_CHILD_COMMAND;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	try {
		const harness = createHarness(cwd);
		const original: ProviderConfig = { api: "openai-codex-responses", streamSimple() { throw new Error("original provider"); } };
		harness.providers.set("openai-codex", original);
		await harness.emit("session_start");
		assert.equal(harness.providers.get("openai-codex"), original, "medium never overrides the provider");
		const tools = harness.selected().tools;
		const dial = harness.commands.get("dial")!;
		await dial.handler("high", harness.ctx);
		assert.deepEqual(harness.selected().tools, [...tools, ...nativeTools]);
		assert.notEqual(harness.providers.get("openai-codex")?.streamSimple, original.streamSimple);
		const prompts = await harness.emit("before_agent_start", { systemPrompt: "base", systemPromptOptions: { cwd } });
		assert.match((prompts.at(-1) as { systemPrompt: string }).systemPrompt, /Prefer spawn_agent.*oracle remains/s);
		assert.ok((await harness.emit("session_before_compact")).every(result => result === undefined), "unused high does not block compaction");

		fakeChildEnv(cwd, "subprocess answer");
		const signal = new AbortController().signal;
		const oracle = await harness.tool("oracle").execute("oracle", { task: "review" }, signal, undefined, harness.ctx);
		assert.equal(oracle.content[0].text, "subprocess answer");
		assert.equal(oracle.details?.model, "anthropic/claude-fable-5-1");
		const task = await harness.tool("Task").execute("task", { description: "isolated", prompt: "work", model: "example/worker-v2" }, signal, undefined, harness.ctx);
		assert.equal(task.details?.model, "example/worker-v2");
		assert.equal(task.content[0].text, "subprocess answer");

		await dial.handler("medium", harness.ctx);
		assert.deepEqual(harness.selected().tools, tools);
		assert.equal(harness.providers.get("openai-codex")?.streamSimple, original.streamSimple);
		await dial.handler("high", harness.ctx);
		// A converter can replace the provider between turns; reclaim it without losing the new owner.
		const replacement: ProviderConfig = { ...original, streamSimple() { throw new Error("replacement provider"); } };
		harness.providers.set("openai-codex", replacement);
		await harness.emit("before_agent_start", { systemPrompt: "base" });
		assert.notEqual(harness.providers.get("openai-codex")?.streamSimple, replacement.streamSimple);
		await harness.emit("session_shutdown");
		assert.equal(harness.providers.get("openai-codex")?.streamSimple, replacement.streamSimple, "/reload must not retain an invalidated extension stream");
	} finally {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		if (oldChildCommand === undefined) delete process.env.PI_DIAL_CHILD_COMMAND; else process.env.PI_DIAL_CHILD_COMMAND = oldChildCommand;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("native records survive deactivation and restore for replay; a new branch releases the transport and compaction", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-dial-replay-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	try {
		const harness = createHarness(cwd, [{
			type: "custom", id: "wire", parentId: null, timestamp: "2026-07-01T00:00:00.000Z",
			customType: "pi-dial-native-record", data: { kind: "agent", marker: "[pi-dial-native:test]", record: {
				type: "agent_message", author: "/root/worker", recipient: "/root", content: [{ type: "encrypted_content", encrypted_content: "opaque" }],
			} },
		}]);
		await harness.emit("session_start");
		assert.equal(harness.selected().thinking, "medium");
		assert.ok(harness.providers.get("openai-codex")?.streamSimple, "medium must replay saved native records");
		assert.ok(harness.selected().tools.every(tool => !nativeTools.includes(tool)));
		assert.ok((await harness.emit("session_before_compact")).some(result => (result as { cancel?: boolean })?.cancel));
		await harness.commands.get("dial")!.handler("high", harness.ctx);
		await harness.setExternalModel("anthropic", "claude-fable-5-1", "high");
		assert.ok(harness.selected().tools.every(tool => !nativeTools.includes(tool)));
		assert.ok((await harness.emit("before_agent_start", { systemPrompt: "base" })).every(result => result === undefined));
		await harness.emit("session_before_tree");
		harness.entries.splice(0);
		await harness.emit("session_tree");
		assert.equal(harness.providers.size, 0);
		assert.ok((await harness.emit("session_before_compact")).every(result => result === undefined));
		await harness.emit("session_shutdown");
	} finally {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		rmSync(cwd, { recursive: true, force: true });
	}
});

for (const [label, config] of Object.entries({
	"non-Codex high": { modes: { high: { model: "anthropic/claude-fable-5-1", thinking: "high" } } },
	"non-Codex high fallback": { modes: { high: { model: "missing/parent", fallbacks: [{ model: "anthropic/claude-fable-5-1", thinking: "high" }] } } },
	"disabled high Task": { modes: { high: { task: false } } },
})) test(`${label} does not enable native collaboration`, async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-dial-auto-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	try {
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "pi-dial.json"), JSON.stringify(config));
		const harness = createHarness(cwd);
		await harness.emit("session_start");
		await harness.commands.get("dial")!.handler("high", harness.ctx);
		assert.ok(harness.selected().tools.every(tool => !nativeTools.includes(tool)));
		assert.equal(harness.providers.size, 0);
		assert.ok((await harness.emit("before_agent_start", { systemPrompt: "base" })).every(result => result === undefined));
	} finally {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("children keep Pi's system prompt: Oracle appends its role, Task adds nothing", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-dial-extension-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const oldChildCommand = process.env.PI_DIAL_CHILD_COMMAND;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	try {
		const argvLog = join(cwd, "argv.jsonl");
		const script = join(cwd, "fake-pi.mjs");
		writeFileSync(
			script,
			`import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"ok"}],stopReason:"stop"}})+"\\n");`,
		);
		process.env.PI_DIAL_CHILD_COMMAND = JSON.stringify({ command: process.execPath, prefixArgs: [script] });
		const harness = createHarness(cwd);
		await harness.emit("session_start");
		const signal = new AbortController().signal;
		await harness.tool("oracle").execute("call-1", { task: "review" }, signal, undefined, harness.ctx);
		await harness.tool("Task").execute("call-2", { description: "work", prompt: "do it" }, signal, undefined, harness.ctx);
		const [oracleArgs, taskArgs] = readFileSync(argvLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
		for (const args of [oracleArgs, taskArgs]) assert.ok(!args.includes("--system-prompt"));
		const appended = oracleArgs[oracleArgs.indexOf("--append-system-prompt") + 1];
		assert.equal(appended, readFileSync(join(import.meta.dirname, "..", "prompts", "oracle.md"), "utf8").trim());
		assert.equal(oracleArgs[oracleArgs.indexOf("--tools") + 1], "read,bash,grep,find,ls,command_session");
		assert.ok(!taskArgs.includes("--append-system-prompt"));
	} finally {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		if (oldChildCommand === undefined) delete process.env.PI_DIAL_CHILD_COMMAND;
		else process.env.PI_DIAL_CHILD_COMMAND = oldChildCommand;
		rmSync(cwd, { recursive: true, force: true });
	}
});

function historicalTaskResult(toolCallId: string, model: string, thinking: string): SessionEntry {
	return {
		type: "message",
		id: `${toolCallId}-result`,
		parentId: null,
		timestamp: "2026-07-01T00:00:00.000Z",
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "Task",
			content: [{ type: "text", text: "done" }],
			details: { kind: "task", mode: "inactive", model, thinking },
			isError: false,
			timestamp: Date.parse("2026-07-01T00:00:00.000Z"),
		},
	};
}

test("Task exposes configured modes and overrides, and renders its resolved model route", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-dial-extension-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const oldChildCommand = process.env.PI_DIAL_CHILD_COMMAND;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	try {
		fakeChildEnv(cwd, "worker answer");
		const historicalTask = historicalTaskResult("historical", "anthropic/claude-fable-5-1", "high");
		const harness = createHarness(cwd, [historicalTask]);
		await harness.emit("session_start");
		const task = harness.tool("Task");
		assert.match(task.description ?? "", /primarily for parallel fan-out/);
		assert.match(task.promptSnippet ?? "", /Parallel fan-out/);
		assert.ok(task.promptGuidelines?.some((guideline) => /parallel fan-out tool by default/.test(guideline)));
		assert.ok(task.promptGuidelines?.some((guideline) => /only one ordinary task, do it yourself/.test(guideline)));
		assert.deepEqual(task.parameters?.properties?.mode?.enum, ["low", "medium", "high", "ultra"]);
		assert.ok(task.parameters?.properties?.model);
		assert.ok(task.parameters?.properties?.thinking);
		assert.equal(task.parameters?.properties?.timeoutMs, undefined);
		assert.ok(harness.tool("oracle").parameters?.properties?.model);
		assert.ok(task.renderCall);
		const theme = harness.ctx.ui.theme;
		const signal = new AbortController().signal;
		const renderTitle = (toolCallId: string, description: string): string =>
			task.renderCall!({ description }, theme, { toolCallId }).render(120)[0].trimEnd();
		const execute = (
			toolCallId: string,
			params: Record<string, unknown>,
			onUpdate?: (update: { content: Array<{ type: string; text: string }> }) => void,
		) => task.execute(toolCallId, params, signal, onUpdate, harness.ctx);

		assert.equal(renderTitle("historical", "Historical task"), "Task: Historical task (claude-fable-5-1 • high)");
		assert.equal(renderTitle("inherited", "Review the parser"), "Task: Review the parser");
		const liveTitles: string[] = [];
		await execute(
			"inherited",
			{ description: "Review the parser", prompt: "Inspect parser.ts" },
			() => liveTitles.push(renderTitle("inherited", "Review the parser")),
		);
		assert.equal(liveTitles[0], "Task: Review the parser (gpt-6-sol • medium)");
		assert.equal(renderTitle("inherited", "Review the parser"), "Task: Review the parser (gpt-6-sol • medium)");

		await execute(
			"explicit",
			{ description: "Pressure-test the prompt", prompt: "Review prompt.md", mode: "ultra" },
		);
		assert.equal(
			renderTitle("explicit", "Pressure-test the prompt"),
			"Task: Pressure-test the prompt (claude-fable-5-1 • high)",
		);
		await execute(
			"override",
			{
				description: "Use a specific worker",
				prompt: "Review worker output",
				model: "example/worker-v2",
				thinking: "low",
			},
		);
		assert.equal(renderTitle("override", "Use a specific worker"), "Task: Use a specific worker (worker-v2 • low)");

		await harness.setExternalModel("anthropic", "claude-fable-5-1", "high");
		await execute(
			"inactive",
			{ description: "Review the fallback", prompt: "Inspect fallback behavior" },
		);
		assert.equal(renderTitle("inactive", "Review the fallback"), "Task: Review the fallback (gpt-6-sol • medium)");

		harness.entries.splice(0, harness.entries.length, historicalTaskResult("switched", "anthropic/claude-fable-5-1", "high"));
		await harness.emit("session_tree");
		assert.equal(renderTitle("switched", "Switched branch task"), "Task: Switched branch task (claude-fable-5-1 • high)");
		assert.equal(renderTitle("inherited", "Review the parser"), "Task: Review the parser");
	} finally {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		if (oldChildCommand === undefined) delete process.env.PI_DIAL_CHILD_COMMAND;
		else process.env.PI_DIAL_CHILD_COMMAND = oldChildCommand;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("status identifies the loaded build and distinguishes config reload from Pi reload", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-dial-extension-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	try {
		const harness = createHarness(cwd, [
			{
				type: "custom",
				customType: "pi-dial-state",
				data: { version: 1, mode: null },
				id: "state",
				parentId: null,
				timestamp: "2026-07-01T00:00:00.000Z",
			},
		]);
		await harness.emit("session_start");
		const dial = harness.commands.get("dial");
		assert.ok(dial);
		await dial.handler("status", harness.ctx);
		assert.match(harness.notifications.at(-1)?.message ?? "", /Pi Dial v0\.1\.2 is inactive/);
		assert.match(harness.notifications.at(-1)?.message ?? "", /Pi's \/reload/);

		await dial.handler("reload", harness.ctx);
		assert.ok(
			harness.notifications.some(({ message, level }) =>
				level === "warning" && message.includes("only reloads Pi Dial configuration"),
			),
		);
	} finally {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("explicit Pi parent selectors temporarily take precedence without clearing the saved dial mode", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-dial-extension-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const oldArgv = process.argv;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	process.argv = [...process.argv, "--model", "anthropic/claude-fable-5-1"];
	try {
		const savedState: SessionEntry = {
			type: "custom",
			customType: "pi-dial-state",
			data: { version: 1, mode: "high" },
			id: "state",
			parentId: null,
			timestamp: "2026-07-01T00:00:00.000Z",
		};
		const harness = createHarness(cwd, [savedState]);
		await harness.emit("session_start");
		assert.equal(harness.selected().model, undefined);
		assert.deepEqual(harness.entries, [savedState]);

		process.argv = oldArgv;
		const resumed = createHarness(cwd, harness.entries);
		await resumed.emit("session_start");
		assert.equal(resumed.selected().model, "openai-codex/gpt-6-sol");
		assert.equal(resumed.selected().thinking, "xhigh");
	} finally {
		process.argv = oldArgv;
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Low does not retain the legacy GLM fallback chain when Opus is unavailable", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-dial-extension-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	try {
		const harness = createHarness(cwd, [], { rejectedProviders: new Set(["anthropic"]) });
		await harness.emit("session_start");
		const dial = harness.commands.get("dial");
		assert.ok(dial);
		await dial.handler("low", harness.ctx);
		assert.equal(harness.selected().model, "openai-codex/gpt-6-sol");
		assert.equal(harness.selected().thinking, "medium");
	} finally {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("busy switches wait for agent_settled and resumed sessions restore their mode", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-dial-extension-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	try {
		const harness = createHarness(cwd);
		await harness.emit("session_start");
		const dial = harness.commands.get("dial");
		assert.ok(dial);
		await dial.handler("high", harness.ctx);
		harness.setIdle(false);
		await dial.handler("low", harness.ctx);
		assert.equal(harness.selected().model, "openai-codex/gpt-6-sol");
		harness.setIdle(true);
		await harness.emit("agent_settled");
		assert.equal(harness.selected().model, "anthropic/claude-opus-5-5");

		const restored = createHarness(cwd, [
			{
				type: "custom",
				customType: "pi-dial-state",
				data: { version: 1, mode: "high" },
				id: "state",
				parentId: null,
				timestamp: "2026-07-01T00:00:00.000Z",
			},
		]);
		await restored.emit("session_start");
		assert.equal(restored.selected().model, "openai-codex/gpt-6-sol");
		assert.equal(restored.selected().thinking, "xhigh");

		await restored.emit("model_select", { source: "set", model: fakeModel("cursor", "glm-5.2") });
		const [promptResult] = await restored.emit("before_agent_start", {
			prompt: "test",
			systemPrompt: "original",
			systemPromptOptions: { cwd },
		});
		assert.equal(promptResult, undefined);
		const state = restored.entries.at(-1);
		assert.equal(state?.type, "custom");
		if (state?.type === "custom") assert.deepEqual(state.data, { version: 1, mode: null });
	} finally {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Pi 0.87 defers sibling settled work until an async pending mode is fully applied", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-dial-settled-ordering-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = cwd;
	const firstStarted = deferredSignal();
	const finishFirst = deferredSignal();
	const modeApplyStarted = deferredSignal();
	const finishModeApply = deferredSignal();
	const requests: string[] = [];
	const codex = createFauxCore({ api: "openai-codex-responses", provider: "openai-codex" });
	codex.setResponses([async (_context, options, _state, model) => {
		requests.push(`${model.provider}/${model.id}:${options?.reasoning}`);
		firstStarted.resolve();
		await finishFirst.promise;
		return fauxAssistantMessage("initial response");
	}]);
	const anthropic = createFauxCore({ api: "anthropic-messages", provider: "anthropic" });
	anthropic.setResponses([(_context, options, _state, model) => {
		requests.push(`${model.provider}/${model.id}:${options?.reasoning}`);
		return fauxAssistantMessage("sibling response");
	}]);

	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
		const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager: settings,
			noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
			extensionFactories: [
				(pi) => {
					let requested = false;
					pi.on("agent_settled", () => {
						if (requested) return;
						requested = true;
						pi.sendUserMessage("work requested by sibling settled handler");
					});
				},
				piDialExtension,
			],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);

		const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: join(cwd, "models.json") });
		runtime.registerProvider("openai-codex", { api: "openai-codex-responses", apiKey: "test", streamSimple: codex.streamSimple });
		runtime.registerProvider("anthropic", { api: "anthropic-messages", apiKey: "test", streamSimple: anthropic.streamSimple });
		({ session } = await createAgentSession({ cwd, agentDir: cwd,
			model: gpt6SolModel(), modelRuntime: runtime, thinkingLevel: "medium",
			resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(cwd), noTools: "builtin",
		}));
		initTheme("dark", false);
		const errors: string[] = [];
		await session.bindExtensions({ onError: error => { errors.push(JSON.stringify(error)); } });

		const setModel = session.setModel.bind(session);
		session.setModel = async (model, options) => {
			if (model.provider === "anthropic") {
				modeApplyStarted.resolve();
				await finishModeApply.promise;
			}
			await setModel(model, options);
		};

		const initialRun = session.prompt("initial work");
		await firstStarted.promise;
		await session.prompt("/dial ultra");
		finishFirst.resolve();
		await modeApplyStarted.promise;
		assert.equal(requests.length, 1, "sibling work must wait for the pending mode");
		finishModeApply.resolve();
		await initialRun;

		assert.deepEqual(requests, [
			"openai-codex/gpt-6-sol:medium",
			"anthropic/claude-fable-5-1:high",
		]);
		assert.deepEqual(errors, []);
	} finally {
		finishFirst.resolve();
		finishModeApply.resolve();
		if (session) {
			await session.abort();
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("re-announced dial selections do not deactivate the dial", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-dial-extension-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	try {
		const harness = createHarness(cwd);
		await harness.emit("session_start");
		const dial = harness.commands.get("dial");
		assert.ok(dial);
		await dial.handler("high", harness.ctx);

		// Pi may dispatch selection events after applyMode returns; matching values are the
		// dial's own change and must not deactivate it.
		await harness.emit("thinking_level_select", { level: "xhigh", previousLevel: "medium" });
		await harness.emit("model_select", { source: "set", model: fakeModel("openai-codex", "gpt-6-sol") });
		assert.equal(harness.selected().model, "openai-codex/gpt-6-sol");
		assert.equal(harness.selected().thinking, "xhigh");

		await harness.emit("thinking_level_select", { level: "low", previousLevel: "xhigh" });
		const state = harness.entries.at(-1);
		assert.equal(state?.type, "custom");
		if (state?.type === "custom") assert.deepEqual(state.data, { version: 1, mode: null });
	} finally {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("the shortcut opens the dial HUD; turning applies live, queues while busy, and esc closes", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-dial-extension-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	try {
		const harness = createHarness(cwd);
		await harness.emit("session_start");
		assert.equal(harness.selected().model, "openai-codex/gpt-6-sol");
		const shortcut = harness.shortcuts.get("ctrl+shift+u");
		assert.ok(shortcut);

		const open = shortcut.handler(harness.ctx);
		const hud = harness.hud();
		assert.ok(hud);
		const frame = hud.render(80).join("\n");
		assert.match(frame, /low.*medium.*high.*ultra/s);
		assert.match(frame, /Agent: {2}openai-codex\/gpt-6-sol \(medium\)/);
		assert.match(frame, /Oracle: openai-codex\/gpt-6-astra \(high\)/);
		assert.match(frame, /Balanced default/);

		hud.handleInput?.("\u001b[C");
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
		assert.equal(harness.selected().model, "openai-codex/gpt-6-sol");
		assert.equal(harness.selected().thinking, "xhigh");
		assert.match(hud.render(80).join("\n"), /Fable second opinion/);

		harness.setIdle(false);
		hud.handleInput?.("\u001b[C");
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
		assert.equal(harness.selected().thinking, "xhigh");
		assert.match(hud.render(80).join("\n"), /queued \u2014 applies when the current turn settles/);
		harness.setIdle(true);
		await harness.emit("agent_settled");
		assert.equal(harness.selected().model, "anthropic/claude-fable-5-1");
		assert.equal(harness.selected().thinking, "high");
		hud.handleInput?.("\u001b");
		await open;
		assert.equal(harness.hud(), undefined);

		const reopened = shortcut.handler(harness.ctx);
		const hud2 = harness.hud();
		assert.ok(hud2);
		hud2.handleInput?.("x");
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
		assert.equal(harness.editorText(), "x");
		await reopened;
		assert.equal(harness.hud(), undefined);
	} finally {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("overlapping dial turns settle on the last requested mode", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-dial-extension-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	try {
		const slowOpus = deferredSignal();
		const harness = createHarness(cwd, [], {
			beforeSetModel: (model) => (model.id === "claude-opus-5-5" ? slowOpus.promise : Promise.resolve()),
		});
		await harness.emit("session_start");
		const dial = harness.commands.get("dial");
		assert.ok(dial);
		const low = dial.handler("low", harness.ctx);
		const ultra = dial.handler("ultra", harness.ctx);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
		slowOpus.resolve();
		await Promise.all([low, ultra]);
		assert.equal(harness.selected().model, "anthropic/claude-fable-5-1");
		assert.equal(harness.selected().thinking, "high");
		await dial.handler("status", harness.ctx);
		assert.match(harness.notifications.at(-1)?.message ?? "", /Ultra: anthropic\/claude-fable-5-1/);
	} finally {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("providers without auth grey out their detent with a reason", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-dial-extension-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	try {
		const harness = createHarness(cwd, [], { rejectedProviders: new Set(["anthropic"]) });
		await harness.emit("session_start");
		const shortcut = harness.shortcuts.get("ctrl+shift+u");
		assert.ok(shortcut);
		const open = shortcut.handler(harness.ctx);
		const hud = harness.hud();
		assert.ok(hud);
		hud.handleInput?.("\u001b[D");
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
		assert.match(hud.render(80).join("\n"), /unavailable \u2014 no authenticated model candidate/);
		assert.equal(harness.selected().model, "openai-codex/gpt-6-sol");
		hud.handleInput?.("\u001b");
		await open;
	} finally {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		rmSync(cwd, { recursive: true, force: true });
	}
});

function fakeChildEnv(dir: string, text: string, delayMs = 0): void {
	const script = join(dir, "fake-pi.mjs");
	writeFileSync(
		script,
		`setTimeout(() => { process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:${JSON.stringify(text)}}],stopReason:"stop"}})+"\\n"); }, ${delayMs});`,
	);
	process.env.PI_DIAL_CHILD_COMMAND = JSON.stringify({ command: process.execPath, prefixArgs: [script] });
}

const inactiveState: SessionEntry = {
	type: "custom",
	customType: "pi-dial-state",
	data: { version: 1, mode: null },
	id: "state",
	parentId: null,
	timestamp: "2026-07-01T00:00:00.000Z",
};

test("inactive dial serves Oracle and Task through the configured fallbacks", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-dial-extension-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const oldChildCommand = process.env.PI_DIAL_CHILD_COMMAND;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	try {
		fakeChildEnv(cwd, "fallback answer");
		const harness = createHarness(cwd, [inactiveState]);
		await harness.emit("session_start");
		assert.equal(harness.selected().model, undefined);

		const signal = new AbortController().signal;
		const oracle = await harness.tool("oracle").execute("call-1", { task: "review" }, signal, undefined, harness.ctx);
		assert.notEqual(oracle.isError, true);
		assert.equal(oracle.details?.mode, "inactive");
		assert.equal(oracle.details?.model, "anthropic/claude-fable-5-1");
		assert.equal(oracle.details?.thinking, "high");
		assert.equal(oracle.content[0].text, "fallback answer");
		assert.equal(oracle.details?.usedFallback, false);

		const task = await harness.tool("Task").execute(
			"call-2",
			{ description: "audit", prompt: "do the audit" },
			signal,
			undefined,
			harness.ctx,
		);
		assert.notEqual(task.isError, true);
		assert.equal(task.details?.mode, "inactive");
		assert.equal(task.details?.model, "openai-codex/gpt-6-sol");
		assert.equal(task.details?.thinking, "medium");
		assert.equal(task.details?.selectionSource, "inactive-fallback");

		const explicit = await harness.tool("Task").execute(
			"call-3",
			{ description: "audit", prompt: "do the audit", mode: "high" },
			signal,
			undefined,
			harness.ctx,
		);
		assert.notEqual(explicit.isError, true);
		assert.equal(explicit.details?.mode, "high");
		assert.equal(explicit.details?.model, "openai-codex/gpt-6-sol");
		assert.equal(explicit.details?.thinking, "xhigh");
		assert.equal(explicit.details?.selectionSource, "parent-inheritance");
	} finally {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		if (oldChildCommand === undefined) delete process.env.PI_DIAL_CHILD_COMMAND;
		else process.env.PI_DIAL_CHILD_COMMAND = oldChildCommand;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("the inactive Oracle fallback avoids pairing the parent model with itself", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-dial-extension-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const oldChildCommand = process.env.PI_DIAL_CHILD_COMMAND;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	try {
		fakeChildEnv(cwd, "second opinion");
		const harness = createHarness(cwd);
		await harness.emit("session_start");
		assert.equal(harness.selected().model, "openai-codex/gpt-6-sol");

		// Reproduce a startup --model flag or manual switch: the dial deactivates.
		await harness.setExternalModel("anthropic", "claude-fable-5-1", "high");
		assert.ok(harness.notifications.some(({ message }) => message.includes("Model changed outside the dial")));

		const signal = new AbortController().signal;
		const oracle = await harness.tool("oracle").execute("call-1", { task: "review" }, signal, undefined, harness.ctx);
		assert.notEqual(oracle.isError, true);
		assert.equal(oracle.details?.mode, "inactive");
		assert.equal(oracle.details?.model, "openai-codex/gpt-6-sol");
		assert.equal(oracle.details?.thinking, "xhigh");
		assert.equal(oracle.details?.selectionSource, "inactive-fallback");
		assert.equal(oracle.details?.usedFallback, false);
	} finally {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		if (oldChildCommand === undefined) delete process.env.PI_DIAL_CHILD_COMMAND;
		else process.env.PI_DIAL_CHILD_COMMAND = oldChildCommand;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("routes apply to inherited children but do not override explicit child config", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-dial-extension-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const oldChildCommand = process.env.PI_DIAL_CHILD_COMMAND;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	try {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "pi-dial.json"),
			JSON.stringify({
				childRouting: {
					oracle: [{ parentModel: "*/*", model: "example/reviewer-v3", thinking: "medium" }],
					task: [
						{
							parentModel: "openai-codex/*",
							model: "anthropic/claude-fable-5-1",
							thinking: "high",
						},
						{
							parentModel: "*/*",
							model: "radius/glm-5.2",
							thinking: "medium",
						},
					],
				},
			}),
		);
		fakeChildEnv(cwd, "routed answer");
		const harness = createHarness(cwd);
		await harness.emit("session_start");
		const signal = new AbortController().signal;

		const task = await harness.tool("Task").execute(
			"call-1",
			{ description: "routed", prompt: "do it" },
			signal,
			undefined,
			harness.ctx,
		);
		assert.notEqual(task.isError, true);
		assert.equal(task.details?.model, "anthropic/claude-fable-5-1");
		assert.equal(task.details?.thinking, "high");
		assert.equal(task.details?.selectionSource, "parent-model-route");

		const dial = harness.commands.get("dial");
		assert.ok(dial);
		await dial.handler("ultra", harness.ctx);
		const oracle = await harness.tool("oracle").execute(
			"call-2",
			{ task: "review" },
			signal,
			undefined,
			harness.ctx,
		);
		assert.notEqual(oracle.isError, true);
		assert.equal(oracle.details?.model, "openai-codex/gpt-6-sol");
		assert.equal(oracle.details?.thinking, "high");
		assert.equal(oracle.details?.selectionSource, "child-config");
	} finally {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		if (oldChildCommand === undefined) delete process.env.PI_DIAL_CHILD_COMMAND;
		else process.env.PI_DIAL_CHILD_COMMAND = oldChildCommand;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("both child tools route arbitrary parent IDs without changing the parent or later defaults", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-dial-extension-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const oldChildCommand = process.env.PI_DIAL_CHILD_COMMAND;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	try {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "custom.md"), "Custom worker prompt");
		const routes = [
			{ parentModel: "example/worker-v?", model: "example/reviewer-v3", thinking: "medium" },
			{ parentModel: "*/*", model: "example/worker-v2", thinking: "low" },
		];
		writeFileSync(join(cwd, ".pi", "pi-dial.json"), JSON.stringify({
			defaultMode: "custom",
			modes: { custom: {
				label: "Custom", description: "Generic model routing", model: "example/worker-v2",
				thinking: "high", oracle: {}, task: {},
			} },
			childRouting: { oracle: routes, task: routes },
		}));
		fakeChildEnv(cwd, "generic answer");
		const harness = createHarness(cwd);
		await harness.emit("session_start");
		assert.ok(harness.tool("Task").parameters?.properties?.mode?.enum?.includes("custom"));
		const before = harness.selected();
		for (const name of ["oracle", "Task"]) {
			const params = name === "oracle" ? { task: "review" } : { description: "work", prompt: "do it" };
			const run = (overrides = {}) => harness.tool(name).execute(
				"call", { ...params, ...overrides }, new AbortController().signal, undefined, harness.ctx,
			);
			const routed = await run();
			assert.notEqual(routed.isError, true);
			assert.equal(routed.details?.model, "example/reviewer-v3");
			assert.equal(routed.details?.thinking, "medium");
			assert.equal(routed.details?.selectionSource, "parent-model-route");
			const overridden = await run({ model: "example/worker-v2", thinking: "low" });
			assert.notEqual(overridden.isError, true);
			assert.equal(overridden.details?.model, "example/worker-v2");
			assert.equal(overridden.details?.thinking, "low");
			assert.equal(overridden.details?.selectionSource, "per-call");
			const again = await run();
			assert.equal(again.details?.model, "example/reviewer-v3");
			assert.equal(again.details?.thinking, "medium");
			assert.deepEqual(harness.selected(), before);
		}
	} finally {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		if (oldChildCommand === undefined) delete process.env.PI_DIAL_CHILD_COMMAND;
		else process.env.PI_DIAL_CHILD_COMMAND = oldChildCommand;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("routes preserve inherited child models as visible fallbacks", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-dial-extension-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const oldChildCommand = process.env.PI_DIAL_CHILD_COMMAND;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	try {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "pi-dial.json"),
			JSON.stringify({
				childRouting: {
					task: [{ parentModel: "openai-codex/*", model: "missing/model", thinking: "high" }],
				},
			}),
		);
		fakeChildEnv(cwd, "fallback answer");
		const harness = createHarness(cwd);
		await harness.emit("session_start");
		const result = await harness.tool("Task").execute(
			"call-1",
			{ description: "routed", prompt: "do it" },
			new AbortController().signal,
			undefined,
			harness.ctx,
		);
		assert.notEqual(result.isError, true);
		assert.equal(result.details?.model, "openai-codex/gpt-6-sol");
		assert.equal(result.details?.thinking, "medium");
		assert.equal(result.details?.selectionSource, "parent-inheritance");
		assert.equal(result.details?.usedFallback, true);
		assert.match(
			result.content[0].text,
			/\[Pi Dial used fallback model openai-codex\/gpt-6-sol \(medium\)\.\]$/,
		);
	} finally {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		if (oldChildCommand === undefined) delete process.env.PI_DIAL_CHILD_COMMAND;
		else process.env.PI_DIAL_CHILD_COMMAND = oldChildCommand;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("per-call model and thinking overrides are strict and visible", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-dial-extension-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const oldChildCommand = process.env.PI_DIAL_CHILD_COMMAND;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	try {
		fakeChildEnv(cwd, "override answer");
		const harness = createHarness(cwd);
		await harness.emit("session_start");
		const signal = new AbortController().signal;

		const thinkingOnly = await harness.tool("oracle").execute(
			"call-1",
			{ task: "review", thinking: "xhigh" },
			signal,
			undefined,
			harness.ctx,
		);
		assert.notEqual(thinkingOnly.isError, true);
		assert.equal(thinkingOnly.details?.model, "openai-codex/gpt-6-astra");
		assert.equal(thinkingOnly.details?.thinking, "xhigh");
		assert.equal(thinkingOnly.details?.selectionSource, "per-call");

		const task = await harness.tool("Task").execute(
			"call-2",
			{
				description: "targeted work",
				prompt: "do it",
				model: "anthropic/claude-fable-5-1",
				thinking: "high",
			},
			signal,
			undefined,
			harness.ctx,
		);
		assert.notEqual(task.isError, true);
		assert.equal(task.details?.model, "anthropic/claude-fable-5-1");
		assert.equal(task.details?.thinking, "high");
		assert.equal(task.details?.selectionSource, "per-call");
		assert.equal(task.content[0].text, "override answer");
		assert.equal(task.details?.usedFallback, false);
		const metaPath = task.details?.run?.artifacts?.metaPath;
		assert.ok(metaPath);
		const meta = JSON.parse(readFileSync(metaPath, "utf8"));
		assert.equal(meta.commandReviewMs, 2 * 60 * 1000);
		assert.equal(meta.selectionSource, "per-call");

		const aliased = await harness.tool("oracle").execute(
			"call-alias",
			{ task: "review", model: "fable", thinking: "high" },
			signal,
			undefined,
			harness.ctx,
		);
		assert.notEqual(aliased.isError, true);
		assert.equal(aliased.details?.model, "anthropic/claude-fable-5-1");

		const unsupported = await harness.tool("Task").execute(
			"call-3",
			{ description: "bad override", prompt: "do it", model: "cursor/glm-5.2", thinking: "low" },
			signal,
			undefined,
			harness.ctx,
		);
		assert.equal(unsupported.isError, true);
		assert.match(unsupported.content[0].text, /does not support thinking:low/);

		const missing = await harness.tool("oracle").execute(
			"call-4",
			{ task: "review", model: "missing/model" },
			signal,
			undefined,
			harness.ctx,
		);
		assert.equal(missing.isError, true);
		assert.match(missing.content[0].text, /missing\/model \(not found\)/);

	} finally {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		if (oldChildCommand === undefined) delete process.env.PI_DIAL_CHILD_COMMAND;
		else process.env.PI_DIAL_CHILD_COMMAND = oldChildCommand;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("configured child fallbacks work with arbitrary model IDs", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-dial-extension-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const oldChildCommand = process.env.PI_DIAL_CHILD_COMMAND;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	try {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "pi-dial.json"), JSON.stringify({
			modes: { high: { oracle: {
				model: "example/unavailable",
				fallbacks: [{ model: "example/reviewer-v3", thinking: "high" }],
			} } },
		}));
		fakeChildEnv(cwd, "configured fallback");
		const harness = createHarness(cwd);
		await harness.emit("session_start");
		const dial = harness.commands.get("dial");
		assert.ok(dial);
		await dial.handler("high", harness.ctx);
		const result = await harness.tool("oracle").execute(
			"call-1",
			{ task: "review" },
			new AbortController().signal,
			undefined,
			harness.ctx,
		);
		assert.notEqual(result.isError, true);
		assert.equal(result.details?.model, "example/reviewer-v3");
		assert.equal(result.details?.thinking, "high");
		assert.equal(result.details?.selectionSource, "child-config");
		assert.equal(result.details?.usedFallback, true);
		assert.match(result.content[0].text, /\[Pi Dial used fallback model example\/reviewer-v3 \(high\)\.\]$/);
		const metaPath = result.details?.run?.artifacts?.metaPath;
		assert.ok(metaPath);
		const meta = JSON.parse(readFileSync(metaPath, "utf8"));
		assert.equal(meta.usedFallback, true);
	} finally {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		if (oldChildCommand === undefined) delete process.env.PI_DIAL_CHILD_COMMAND;
		else process.env.PI_DIAL_CHILD_COMMAND = oldChildCommand;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("inactive fallbacks fail gracefully without authenticated candidates", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-dial-extension-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	try {
		const harness = createHarness(cwd, [inactiveState], { rejectedProviders: new Set(["anthropic", "openai-codex"]) });
		await harness.emit("session_start");
		const signal = new AbortController().signal;

		const oracle = await harness.tool("oracle").execute("call-1", { task: "review" }, signal, undefined, harness.ctx);
		assert.equal(oracle.isError, true);
		assert.match(oracle.content[0].text, /Oracle model selection failed: No usable child model/);

		const task = await harness.tool("Task").execute(
			"call-2",
			{ description: "audit", prompt: "do the audit" },
			signal,
			undefined,
			harness.ctx,
		);
		assert.equal(task.isError, true);
		assert.match(task.content[0].text, /Task model selection failed: No usable child model/);
	} finally {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a configuration error blocks Oracle and Task instead of running stale fallbacks", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-dial-extension-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	try {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "pi-dial.json"), "{ not json");
		const harness = createHarness(cwd);
		await harness.emit("session_start");
		assert.ok(harness.notifications.some(({ level }) => level === "error"));

		const signal = new AbortController().signal;
		const oracle = await harness.tool("oracle").execute("call-1", { task: "review" }, signal, undefined, harness.ctx);
		assert.equal(oracle.isError, true);
		assert.match(oracle.content[0].text, /Pi dial is unavailable/);

		const task = await harness.tool("Task").execute(
			"call-2",
			{ description: "audit", prompt: "do the audit" },
			signal,
			undefined,
			harness.ctx,
		);
		assert.equal(task.isError, true);
		assert.match(task.content[0].text, /Pi dial is unavailable/);
	} finally {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a malformed PI_DIAL_CHILD_COMMAND returns a structured error from both tools", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-dial-extension-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const oldChildCommand = process.env.PI_DIAL_CHILD_COMMAND;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	try {
		process.env.PI_DIAL_CHILD_COMMAND = "not json";
		const harness = createHarness(cwd, [inactiveState]);
		await harness.emit("session_start");
		const signal = new AbortController().signal;

		const oracle = await harness.tool("oracle").execute("call-1", { task: "review" }, signal, undefined, harness.ctx);
		assert.equal(oracle.isError, true);
		assert.match(oracle.content[0].text, /PI_DIAL_CHILD_COMMAND is not valid JSON/);

		const task = await harness.tool("Task").execute(
			"call-2",
			{ description: "audit", prompt: "do the audit" },
			signal,
			undefined,
			harness.ctx,
		);
		assert.equal(task.isError, true);
		assert.match(task.content[0].text, /PI_DIAL_CHILD_COMMAND is not valid JSON/);
	} finally {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		if (oldChildCommand === undefined) delete process.env.PI_DIAL_CHILD_COMMAND;
		else process.env.PI_DIAL_CHILD_COMMAND = oldChildCommand;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Task failures cite run artifacts and onUpdate streams child activity", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-dial-extension-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const oldChildCommand = process.env.PI_DIAL_CHILD_COMMAND;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	try {
		const script = join(cwd, "busy-pi.mjs");
		writeFileSync(
			script,
			`process.stdout.write(JSON.stringify({type:"tool_execution_start",toolCallId:"t1",toolName:"bash",args:{}})+"\\n");\n` +
				`process.stderr.write("synthetic child failure");\n` +
				`process.exitCode = 7;`,
		);
		process.env.PI_DIAL_CHILD_COMMAND = JSON.stringify({ command: process.execPath, prefixArgs: [script] });
		const harness = createHarness(cwd, [inactiveState]);
		await harness.emit("session_start");
		const signal = new AbortController().signal;

		const updates: string[] = [];
		const failed = await harness.tool("Task").execute(
			"call-1",
			{ description: "stuck work", prompt: "never finishes" },
			signal,
			(update) => updates.push(update.content[0].text),
			harness.ctx,
		);
		assert.equal(failed.isError, true);
		assert.match(failed.content[0].text, /synthetic child failure/);
		assert.match(failed.content[0].text, /Run artifacts: /);
		assert.ok(updates.some((text) => text.includes("1 tool call, last: bash")));

		const runsDir = join(cwd, "agent", "pi-dial", "runs");
		assert.ok(failed.content[0].text.includes(runsDir));

		fakeChildEnv(cwd, "recovered");
		const succeeded = (await harness.tool("Task").execute(
			"call-2",
			{ description: "ok work", prompt: "finishes" },
			signal,
			undefined,
			harness.ctx,
		)) as ToolResultLike & { details?: { run?: { artifacts?: { dir?: string } } } };
		assert.notEqual(succeeded.isError, true);
		assert.ok(succeeded.details?.run?.artifacts?.dir?.startsWith(runsDir));
		assert.doesNotMatch(succeeded.content[0].text, /Run artifacts:/);
	} finally {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		if (oldChildCommand === undefined) delete process.env.PI_DIAL_CHILD_COMMAND;
		else process.env.PI_DIAL_CHILD_COMMAND = oldChildCommand;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Task calls start without an extension-level concurrency limit", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-dial-extension-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const oldChildCommand = process.env.PI_DIAL_CHILD_COMMAND;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	try {
		fakeChildEnv(cwd, "slow worker done", 60);
		const harness = createHarness(cwd, [inactiveState]);
		await harness.emit("session_start");
		const signal = new AbortController().signal;
		const updates = Array.from({ length: 6 }, () => [] as string[]);
		const runs = updates.map((callUpdates, index) =>
			harness.tool("Task").execute(
				`call-${index}`,
				{ description: `worker ${index}`, prompt: "slow work" },
				signal,
				(update) => callUpdates.push(update.content[0].text),
				harness.ctx,
			),
		);
		const results = await Promise.all(runs);
		assert.ok(updates.every((callUpdates) => /^Task starting/.test(callUpdates[0])));
		assert.ok(updates.flat().every((update) => !/queued/.test(update)));
		assert.ok(results.every((result) => result.isError !== true));
	} finally {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		if (oldChildCommand === undefined) delete process.env.PI_DIAL_CHILD_COMMAND;
		else process.env.PI_DIAL_CHILD_COMMAND = oldChildCommand;
		rmSync(cwd, { recursive: true, force: true });
	}
});
