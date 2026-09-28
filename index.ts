import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, StringEnum, Type, type Api, type Model } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	runChildAgent,
	type ChildRunProgress,
	type ChildRunRequest,
	type ChildSelectionSource,
	type ChildRunResult,
} from "./child-agent.ts";
import { DialHud, type HudApplyOutcome, type HudMode } from "./hud.ts";
import { installNativeCollaboration, type CollaborationDependencies } from "./collaboration.ts";
import {
	createDefaultConfig,
	DEFAULT_COMMAND_REVIEW_MS,
	loadDialConfig,
	loadPrompt,
	resolveModelRef,
	splitModelSpec,
	THINKING_LEVEL_VALUES,
	type ChildAgentConfig,
	type ChildRoute,
	type ConfigPath,
	type DialConfig,
	type DialPreset,
	type InactiveChildConfig,
	type ModelFallback,
} from "./config.ts";
import { buildOracleInput, buildTaskInput, serializeParentThread } from "./prompt.ts";
import wutExtension from "./wut.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PI_DIAL_VERSION = "0.1.0";
const STATE_ENTRY = "pi-dial-state";
const STATUS_KEY = "pi-dial";
const STATE_VERSION = 1;
const DEFAULT_OUTPUT_LIMIT_CHARS = 50_000;
const DEFAULT_ORACLE_CONTEXT_CHARS = 120_000;

interface PersistedState {
	version: number;
	mode: string | null;
}

interface ResolvedModeModel {
	model: Model<Api>;
	spec: string;
	thinking: ThinkingLevel;
}

interface ChildWorkerCandidate extends ModelFallback {
	selectionSource: ChildSelectionSource;
}

interface ChildWorkerTemplate {
	candidates: ChildWorkerCandidate[];
	promptFile?: string;
	tools: string[];
	extensionPaths: string[];
	skillPaths: string[];
	inheritContext: boolean;
	inheritSkills: boolean;
	commandReviewMs: number;
	outputLimitChars: number;
}

interface ChildWorkerSettings extends Omit<ChildWorkerTemplate, "candidates"> {
	model: string;
	thinking: ThinkingLevel;
	selectionSource: ChildSelectionSource;
	usedFallback: boolean;
}

interface DialToolDetails {
	kind: "oracle" | "task";
	mode: string;
	model?: string;
	thinking?: ThinkingLevel;
	description?: string;
	selectionSource?: ChildSelectionSource;
	usedFallback?: boolean;
	run?: ChildRunResult;
}

const ModelOverrideParameters = {
	model: Type.Optional(
		Type.String({
			minLength: 1,
			description: "Exact provider/model, or a configured model alias such as fable, overriding this child run",
		}),
	),
	thinking: Type.Optional(
		StringEnum(THINKING_LEVEL_VALUES, {
			description: "Exact Pi thinking level override for this child run",
		}),
	),
};

const OracleParameters = Type.Object({
	task: Type.String({
		description: "A specific review, debugging, planning, or architecture question for the paired read-only expert",
	}),
	...ModelOverrideParameters,
});

function taskParameters(modes: readonly string[]) {
	return Type.Object({
		description: Type.String({ description: "Short label describing the delegated work" }),
		prompt: Type.String({
			description: "Complete worker brief: objective, paths, constraints, conventions, and verification to run",
		}),
		mode: Type.Optional(
			StringEnum(modes, {
				description:
					"Configured dial mode whose prompt, tools, limits, and default child routing should be used. Omit to use the current mode.",
			}),
		),
		...ModelOverrideParameters,
	});
}

function runsBaseDir(): string {
	return join(getAgentDir(), "pi-dial", "runs");
}

function describeProgress(progress: ChildRunProgress): string {
	if (progress.toolCalls === 0 && progress.assistantTurns === 0) {
		return `starting (artifacts: ${progress.artifactsDir})`;
	}
	const parts = [`${progress.toolCalls} tool call${progress.toolCalls === 1 ? "" : "s"}`];
	if (progress.lastTool) parts.push(`last: ${progress.lastTool}`);
	parts.push(`${progress.assistantTurns} assistant turn${progress.assistantTurns === 1 ? "" : "s"}`);
	return parts.join(", ");
}

function failureText(message: string, run: ChildRunResult): string {
	const sections = [message];
	if (run.artifacts) sections.push(`Run artifacts: ${run.artifacts.dir}`);
	return sections.join("\n\n");
}

function textResult(text: string, details: DialToolDetails, isError = false) {
	return {
		content: [{ type: "text" as const, text }],
		details,
		...(isError ? { isError: true } : {}),
	};
}

function modeCandidates(preset: DialPreset): Array<{ model: string; thinking: ThinkingLevel }> {
	return [{ model: preset.model, thinking: preset.thinking }, ...preset.fallbacks];
}

function childTemplate(
	child: ChildAgentConfig,
	preset: DialPreset,
	resolvedMain: ResolvedModeModel | undefined,
): ChildWorkerTemplate {
	const inheritedModel = resolvedMain?.spec ?? preset.model;
	const inheritedThinking = resolvedMain?.thinking ?? preset.thinking;
	const primarySource =
		child.model !== undefined || child.thinking !== undefined ? "child-config" : "parent-inheritance";
	return {
		candidates: [
			{
				model: child.model ?? inheritedModel,
				thinking: child.thinking ?? inheritedThinking,
				selectionSource: primarySource,
			},
			...(child.fallbacks ?? []).map((fallback) => ({ ...fallback, selectionSource: "child-config" as const })),
		],
		promptFile: child.promptFile,
		tools: [...(child.tools ?? [])],
		extensionPaths: [...(child.extensionPaths ?? [])],
		skillPaths: [...(child.skillPaths ?? [])],
		inheritContext: child.inheritContext ?? true,
		inheritSkills: child.inheritSkills ?? true,
		commandReviewMs: child.commandReviewMs ?? DEFAULT_COMMAND_REVIEW_MS,
		outputLimitChars: child.outputLimitChars ?? DEFAULT_OUTPUT_LIMIT_CHARS,
	};
}

function inactiveChildTemplate(
	child: InactiveChildConfig,
	avoidModel?: { provider: string; id: string },
): ChildWorkerTemplate {
	const avoidSpec = avoidModel && `${avoidModel.provider}/${avoidModel.id}`;
	const candidates = avoidSpec
		? [
				...child.fallbacks.filter(({ model }) => model !== avoidSpec),
				...child.fallbacks.filter(({ model }) => model === avoidSpec),
			]
		: child.fallbacks;
	return {
		candidates: candidates.map((candidate) => ({ ...candidate, selectionSource: "inactive-fallback" })),
		promptFile: child.promptFile,
		tools: [...(child.tools ?? [])],
		extensionPaths: [...(child.extensionPaths ?? [])],
		skillPaths: [...(child.skillPaths ?? [])],
		inheritContext: child.inheritContext ?? true,
		inheritSkills: child.inheritSkills ?? true,
		commandReviewMs: child.commandReviewMs ?? DEFAULT_COMMAND_REVIEW_MS,
		outputLimitChars: child.outputLimitChars ?? DEFAULT_OUTPUT_LIMIT_CHARS,
	};
}

function matchesModelPattern(pattern: string, spec: string): boolean {
	const expression = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replaceAll("*", ".*")
		.replaceAll("?", ".");
	return new RegExp(`^${expression}$`).test(spec);
}

function applyChildRoute(
	template: ChildWorkerTemplate,
	routes: ChildRoute[],
	parentModel?: { provider: string; id: string },
): ChildWorkerTemplate {
	if (!parentModel || template.candidates[0]?.selectionSource !== "parent-inheritance") return template;
	const parentSpec = `${parentModel.provider}/${parentModel.id}`;
	const route = routes.find(({ parentModel }) => matchesModelPattern(parentModel, parentSpec));
	if (!route) return template;
	return {
		...template,
		candidates: [
			{ model: route.model, thinking: route.thinking, selectionSource: "parent-model-route" },
			...template.candidates,
		],
	};
}

function resolveChildTemplate(
	template: ChildWorkerTemplate,
	overrides: { model?: string; thinking?: ThinkingLevel },
	registry: Pick<ExtensionContext["modelRegistry"], "find" | "hasConfiguredAuth">,
): { settings?: ChildWorkerSettings; error?: string } {
	const hasOverride = overrides.model !== undefined || overrides.thinking !== undefined;
	const primary = template.candidates[0]!;
	const candidates = hasOverride
		? [
				{
					model: overrides.model ?? primary.model,
					thinking: overrides.thinking ?? primary.thinking,
					selectionSource: "per-call" as const,
				},
			]
		: template.candidates;

	const failures: string[] = [];
	for (const [index, candidate] of candidates.entries()) {
		let parsed: { provider: string; modelId: string };
		try {
			parsed = splitModelSpec(candidate.model);
		} catch {
			failures.push(`${candidate.model} (expected provider/model)`);
			continue;
		}
		const model = registry.find(parsed.provider, parsed.modelId);
		if (!model) {
			failures.push(`${candidate.model} (not found)`);
			continue;
		}
		if (!registry.hasConfiguredAuth(model)) {
			failures.push(`${candidate.model} (authentication unavailable)`);
			continue;
		}
		if (clampThinkingLevel(model, candidate.thinking) !== candidate.thinking) {
			failures.push(`${candidate.model} (does not support thinking:${candidate.thinking})`);
			continue;
		}
		return {
			settings: {
				...template,
				model: candidate.model,
				thinking: candidate.thinking,
				selectionSource: candidate.selectionSource,
				usedFallback: !hasOverride && index > 0,
			},
		};
	}
	return { error: `No usable child model: ${failures.join(", ")}` };
}

function appendFallbackNote(text: string, settings: ChildWorkerSettings): string {
	if (!settings.usedFallback) return text;
	return `${text}\n\n[Pi Dial used fallback model ${settings.model} (${settings.thinking}).]`;
}

function taskRouteLabel(model: string, thinking: ThinkingLevel): string {
	return `${splitModelSpec(model).modelId} • ${thinking}`;
}

/**
 * Optional JSON override ({"command": ..., "prefixArgs": [...]}) for the child Pi invocation.
 * Used by tests to fake the child process; also useful to point children at a specific Pi binary.
 */
function childCommandOverride(): ChildRunRequest["commandOverride"] {
	const raw = process.env.PI_DIAL_CHILD_COMMAND?.trim();
	if (!raw) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`PI_DIAL_CHILD_COMMAND is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("PI_DIAL_CHILD_COMMAND must be a JSON object");
	}
	const candidate = parsed as { command?: unknown; prefixArgs?: unknown };
	if (typeof candidate.command !== "string" || candidate.command.length === 0) {
		throw new Error('PI_DIAL_CHILD_COMMAND must include a non-empty "command" string');
	}
	const prefixArgs = candidate.prefixArgs ?? [];
	if (!Array.isArray(prefixArgs) || !prefixArgs.every((arg) => typeof arg === "string")) {
		throw new Error('PI_DIAL_CHILD_COMMAND "prefixArgs" must be an array of strings');
	}
	return { command: candidate.command, prefixArgs };
}

function latestState(entries: SessionEntry[]): PersistedState | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
		const data = entry.data;
		if (typeof data !== "object" || data === null) continue;
		const candidate = data as Partial<PersistedState>;
		if (candidate.version !== STATE_VERSION) continue;
		if (candidate.mode === null || typeof candidate.mode === "string") return candidate as PersistedState;
	}
	return undefined;
}

function projectConfigPath(cwd: string): string {
	return join(cwd, ".pi", "pi-dial.json");
}

export default function piDialExtension(pi: ExtensionAPI, collaborationDependencies: Omit<CollaborationDependencies, "enabled"> = {}): void {
	wutExtension(pi);
	let config = createDefaultConfig(EXTENSION_DIR);
	let configError: string | undefined;
	let activeMode: string | undefined;
	let activeModel: ResolvedModeModel | undefined;
	let pendingMode: string | undefined;
	let applyingMode = false;
	let persistedMode: string | null | undefined;
	let shortcutRegistered: string | false | undefined;
	const taskRenderRoutes = new Map<string, string>();
	let openHud: DialHud | undefined;

	const restoreTaskRenderRoutes = (entries: SessionEntry[]): void => {
		taskRenderRoutes.clear();
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
			const details = entry.message.details as Partial<DialToolDetails> | undefined;
			if (
				entry.message.toolName !== "Task" ||
				details?.kind !== "task" ||
				typeof details.model !== "string" ||
				typeof details.thinking !== "string" ||
				!(THINKING_LEVEL_VALUES as readonly string[]).includes(details.thinking)
			) continue;
			try {
				taskRenderRoutes.set(
					entry.message.toolCallId,
					taskRouteLabel(details.model, details.thinking as ThinkingLevel),
				);
			} catch {
				// Ignore malformed historical details; the Task row still renders without a route suffix.
			}
		}
	};

	pi.registerFlag("dial", {
		description: "Start with a Pi dial mode",
		type: "string",
	});
	pi.registerFlag("dial-config", {
		description: "Additional Pi dial JSON configuration file",
		type: "string",
	});

	const updateStatus = (ctx: ExtensionContext): void => {
		if (configError) {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("error", "dial:error"));
			return;
		}
		if (!activeMode || !activeModel) {
			if (pendingMode) {
				ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", `dial → ${pendingMode}`));
			} else {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			}
			return;
		}
		const color = config.modes[activeMode]?.color ?? "accent";
		const pending = pendingMode && pendingMode !== activeMode ? ` → ${pendingMode}` : "";
		ctx.ui.setStatus(
			STATUS_KEY,
			ctx.ui.theme.fg(color, `dial:${activeMode} ${activeModel.thinking}${pending}`),
		);
	};

	const persistState = (mode: string | null): void => {
		if (!config.persistSelection || persistedMode === mode) return;
		pi.appendEntry<PersistedState>(STATE_ENTRY, { version: STATE_VERSION, mode });
		persistedMode = mode;
	};

	const loadConfiguration = (ctx: ExtensionContext): boolean => {
		const paths: ConfigPath[] = [
			{ path: join(getAgentDir(), "pi-dial.json") },
			{ path: projectConfigPath(ctx.cwd) },
		];
		const explicit = String(pi.getFlag("dial-config") ?? process.env.PI_DIAL_CONFIG ?? "").trim();
		if (explicit) {
			const expanded = explicit.replace(/^~(?=$|\/)/, homedir());
			paths.push({ path: isAbsolute(expanded) ? expanded : resolve(ctx.cwd, expanded), required: true });
		}

		try {
			const nextConfig = loadDialConfig(EXTENSION_DIR, paths);
			config = nextConfig;
			configError = undefined;
			registerTaskTool();
			return true;
		} catch (error) {
			configError = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Pi dial configuration error: ${configError}`, "error");
			updateStatus(ctx);
			return false;
		}
	};

	const resolveAndSetModeModel = async (
		preset: DialPreset,
		ctx: ExtensionContext,
	): Promise<ResolvedModeModel> => {
		const failures: string[] = [];
		for (const candidate of modeCandidates(preset)) {
			const parsed = splitModelSpec(candidate.model);
			const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
			if (!model) {
				failures.push(`${candidate.model} (not found)`);
				continue;
			}
			const effectiveThinking = clampThinkingLevel(model, candidate.thinking);
			if (effectiveThinking !== candidate.thinking) {
				failures.push(`${candidate.model} (does not support thinking:${candidate.thinking})`);
				continue;
			}
			const selected = await pi.setModel(model);
			if (!selected) {
				failures.push(`${candidate.model} (authentication unavailable)`);
				continue;
			}
			return { model, spec: candidate.model, thinking: candidate.thinking };
		}
		throw new Error(`No usable model candidate: ${failures.join(", ")}`);
	};

	const resolvePresetModelForChild = (
		preset: DialPreset,
		ctx: ExtensionContext,
	): ResolvedModeModel | undefined => {
		for (const candidate of modeCandidates(preset)) {
			const parsed = splitModelSpec(candidate.model);
			const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
			if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) continue;
			if (clampThinkingLevel(model, candidate.thinking) !== candidate.thinking) continue;
			return { model, spec: candidate.model, thinking: candidate.thinking };
		}
		return undefined;
	};

	const applyModeNow = async (
		mode: string,
		ctx: ExtensionContext,
		options: { notify: boolean; persist: boolean },
	): Promise<{ ok: boolean; error?: string }> => {
		const failure = (error: string): { ok: false; error: string } => {
			if (options.notify) ctx.ui.notify(error, "error");
			return { ok: false, error };
		};
		if (configError) return failure(`Pi dial is unavailable: ${configError}`);
		const preset = config.modes[mode];
		if (!preset) return failure(`Unknown dial mode "${mode}". Available: ${config.order.join(", ")}`);

		try {
			applyingMode = true;
			const resolvedModel = await resolveAndSetModeModel(preset, ctx);
			pi.setThinkingLevel(resolvedModel.thinking);
			activeMode = mode;
			activeModel = resolvedModel;
			pendingMode = undefined;
			if (options.persist) persistState(mode);
			await collaboration.sync(ctx);
			updateStatus(ctx);
			if (options.notify) {
				ctx.ui.notify(
					`Dial: ${preset.label} — ${resolvedModel.spec}, thinking:${resolvedModel.thinking}`,
					"info",
				);
			}
			return { ok: true };
		} catch (error) {
			return failure(
				`Could not activate dial mode "${mode}": ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			applyingMode = false;
		}
	};

	// Mode changes are asynchronous; run them in request order so the last request wins.
	let modeApplication: Promise<unknown> = Promise.resolve();
	const applyMode = (
		mode: string,
		ctx: ExtensionContext,
		options: { notify: boolean; persist: boolean },
	): Promise<{ ok: boolean; error?: string }> => {
		const result = modeApplication.then(() => applyModeNow(mode, ctx, options));
		modeApplication = result.catch(() => undefined);
		return result;
	};

	const applyOrQueueMode = async (mode: string, ctx: ExtensionContext): Promise<void> => {
		if (!ctx.isIdle()) {
			if (!config.modes[mode]) {
				ctx.ui.notify(`Unknown dial mode "${mode}". Available: ${config.order.join(", ")}`, "error");
				return;
			}
			pendingMode = mode;
			updateStatus(ctx);
			ctx.ui.notify(`Dial mode "${mode}" queued for the next user turn`, "info");
			return;
		}
		await applyMode(mode, ctx, { notify: true, persist: true });
	};

	const dialModeKeys = (): string[] => {
		const detents = config.order.filter((mode) => config.modes[mode].dial);
		return detents.length > 0 ? detents : config.order;
	};

	const cycleMode = async (ctx: ExtensionContext): Promise<void> => {
		const keys = dialModeKeys();
		const currentIndex = activeMode ? keys.indexOf(activeMode) : -1;
		const nextMode = keys[(currentIndex + 1) % keys.length];
		await applyOrQueueMode(nextMode, ctx);
	};

	const availabilityForPreset = (
		preset: DialPreset,
		ctx: ExtensionContext,
	): { resolved?: ResolvedModeModel; reason?: string } => {
		const resolved = resolvePresetModelForChild(preset, ctx);
		if (!resolved) return { reason: "no authenticated model candidate" };
		return { resolved };
	};

	const hudModeFor = (mode: string, ctx: ExtensionContext): HudMode => {
		const preset = config.modes[mode];
		const availability = availabilityForPreset(preset, ctx);
		const resolved = mode === activeMode && activeModel ? activeModel : availability.resolved;
		const agent = resolved
			? `${resolved.spec} (${resolved.thinking})`
			: `${preset.model} (${preset.thinking})`;
		let oracle: string | undefined;
		if (preset.oracle !== false) {
			const template = applyChildRoute(
				childTemplate(preset.oracle, preset, resolved),
				config.childRouting.oracle,
				resolved?.model,
			);
			const child = resolveChildTemplate(template, {}, ctx.modelRegistry);
			oracle = child.settings
				? `${child.settings.model} (${child.settings.thinking})`
				: `unavailable (${child.error})`;
		}
		return {
			key: mode,
			label: preset.label,
			description: preset.description,
			agent,
			oracle,
			color: preset.color,
			unavailableReason: availability.reason,
		};
	};

	const openDialHud = async (ctx: ExtensionContext): Promise<void> => {
		if (configError) {
			ctx.ui.notify(`Pi dial is unavailable: ${configError}`, "error");
			return;
		}
		if (openHud && !openHud.isClosed) {
			openHud.turnRight();
			return;
		}
		const detents = config.order.filter((mode) => config.modes[mode].dial).map((mode) => hudModeFor(mode, ctx));
		const extras = config.order.filter((mode) => !config.modes[mode].dial).map((mode) => hudModeFor(mode, ctx));
		if (detents.length === 0 && extras.length === 0) return;
		await ctx.ui.custom<undefined>((tui, theme, _keybindings, done) => {
			const hud = new DialHud(
				{
					detents,
					extras,
					activeKey: pendingMode ?? activeMode,
					shortcut: config.shortcut,
					autoCloseMs: config.hudAutoCloseMs,
					theme,
					onApply: async (mode): Promise<HudApplyOutcome> => {
						if (!ctx.isIdle()) {
							pendingMode = mode;
							updateStatus(ctx);
							return { status: "queued" };
						}
						const result = await applyMode(mode, ctx, { notify: false, persist: true });
						if (result.ok) return { status: "applied" };
						return { status: "failed", error: result.error ?? "activation failed" };
					},
					// Called after the HUD closes so the restored editor receives the typed text.
					onPassthroughText: (text) => ctx.ui.setEditorText(ctx.ui.getEditorText() + text),
					requestRender: () => tui.requestRender(),
				},
				() => done(undefined),
			);
			openHud = hud;
			return hud;
		});
		openHud = undefined;
	};

	const registerConfiguredShortcut = (ctx: ExtensionContext): void => {
		if (shortcutRegistered !== undefined) {
			if (shortcutRegistered !== config.shortcut) {
				ctx.ui.notify("Pi dial shortcut changed; run /reload to replace the registered key", "warning");
			}
			return;
		}
		shortcutRegistered = config.shortcut;
		if (config.shortcut === false) return;
		pi.registerShortcut(config.shortcut, {
			description: "Open the Pi dial",
			handler: async (shortcutCtx: ExtensionContext) => {
				if (!shortcutCtx.hasUI) {
					await cycleMode(shortcutCtx);
					return;
				}
				await openDialHud(shortcutCtx);
			},
		});
	};

	pi.registerCommand("dial", {
		description: "Select, inspect, or reload the Pi dial configuration",
		getArgumentCompletions: (prefix) => {
			const commands = [...config.order, "status", "reload-config", "next"];
			return commands.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const command = args.trim();
			if (command === "status") {
				if (configError) ctx.ui.notify(`Pi Dial v${PI_DIAL_VERSION} configuration error: ${configError}`, "error");
				else if (!activeMode || !activeModel) {
					ctx.ui.notify(
						`Pi Dial v${PI_DIAL_VERSION} is inactive. Use /dial <mode> to activate it; use Pi's /reload after updating extension code.`,
						"info",
					);
				} else {
					const preset = config.modes[activeMode];
					ctx.ui.notify(
						`Pi Dial v${PI_DIAL_VERSION} — ${preset.label}: ${activeModel.spec}, thinking:${activeModel.thinking}`,
						"info",
					);
				}
				return;
			}
			if (command === "reload" || command === "reload-config") {
				if (command === "reload") {
					ctx.ui.notify(
						`/dial reload only reloads Pi Dial configuration. Use Pi's /reload after updating extension code.`,
						"warning",
					);
				}
				if (!loadConfiguration(ctx)) { await collaboration.sync(ctx); return; }
				registerConfiguredShortcut(ctx);
				const target = activeMode && config.modes[activeMode] ? activeMode : config.defaultMode;
				await applyMode(target, ctx, { notify: true, persist: true });
				return;
			}
			if (!command && ctx.hasUI) {
				await openDialHud(ctx);
				return;
			}
			if (command === "next") {
				await cycleMode(ctx);
				return;
			}
			if (command) {
				await applyOrQueueMode(command, ctx);
				return;
			}
			const options = config.order.map((mode) => {
				const preset = config.modes[mode];
				return `${mode}${mode === activeMode ? " (active)" : ""} — ${preset.description}`;
			});
			const selected = await ctx.ui.select("Pi dial", options);
			if (!selected) return;
			await applyOrQueueMode(selected.split(/\s/)[0], ctx);
		},
	});

	pi.registerTool({
		name: "oracle",
		label: "Oracle",
		description:
			"Ask the current dial mode's paired read-only expert for a second opinion. The Oracle sees the active parent-thread transcript and can inspect the workspace, but returns only its final advisory answer. When the dial is inactive, a configured fallback expert answers instead.",
		promptSnippet: "Paired read-only expert with access to the parent-thread context",
		promptGuidelines: [
			"Use oracle for hard review, debugging, planning, or architecture questions where an independent second opinion materially helps.",
			"Give the Oracle a specific task and treat its answer as advisory; continue and apply the advice yourself.",
			"Pass model and/or thinking only for an intentional strict per-call override.",
		],
		parameters: OracleParameters,
		executionMode: "parallel",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (configError) {
				return textResult(
					`Pi dial is unavailable: ${configError}`,
					{ kind: "oracle", mode: activeMode ?? "inactive" },
					true,
				);
			}
			let commandOverride: ChildRunRequest["commandOverride"];
			try {
				commandOverride = childCommandOverride();
			} catch (error) {
				return textResult(
					error instanceof Error ? error.message : String(error),
					{ kind: "oracle", mode: activeMode ?? "inactive" },
					true,
				);
			}
			const mode = activeMode;
			const parentModel = mode ? activeModel?.model : ctx.model;
			let runMode: string;
			let template: ChildWorkerTemplate;
			let maxContextChars: number;
			if (mode) {
				const preset = config.modes[mode];
				if (preset.oracle === false) {
					return textResult(`Oracle is disabled for dial mode "${mode}".`, { kind: "oracle", mode }, true);
				}
				runMode = mode;
				template = childTemplate(preset.oracle, preset, activeModel);
				maxContextChars = preset.oracle.maxContextChars ?? DEFAULT_ORACLE_CONTEXT_CHARS;
			} else {
				const fallback = config.inactive.oracle;
				if (fallback === false) {
					return textResult(
						"Pi dial is inactive and its inactive Oracle fallback is disabled. Select a mode with /dial.",
						{ kind: "oracle", mode: "inactive" },
						true,
					);
				}
				runMode = "inactive";
				template = inactiveChildTemplate(fallback, parentModel);
				maxContextChars = fallback.maxContextChars ?? DEFAULT_ORACLE_CONTEXT_CHARS;
			}
			template = applyChildRoute(template, config.childRouting.oracle, parentModel);
			const resolved = resolveChildTemplate(
				template,
				{ model: params.model && resolveModelRef(config, params.model.trim()), thinking: params.thinking },
				ctx.modelRegistry,
			);
			if (!resolved.settings) {
				return textResult(
					`Oracle model selection failed: ${resolved.error}`,
					{ kind: "oracle", mode: runMode },
					true,
				);
			}
			const settings = resolved.settings;
			const details: DialToolDetails = {
				kind: "oracle",
				mode: runMode,
				model: settings.model,
				thinking: settings.thinking,
				selectionSource: settings.selectionSource,
				usedFallback: settings.usedFallback,
			};
			const transcript = serializeParentThread(ctx.sessionManager.buildContextEntries(), maxContextChars);
			onUpdate?.({
				content: [{ type: "text", text: `Oracle running with ${settings.model} (${settings.thinking})...` }],
				details,
			});
			const run = await runChildAgent(
				{
					kind: "oracle",
					mode: runMode,
					model: settings.model,
					thinking: settings.thinking,
					appendSystemPrompt: settings.promptFile && loadPrompt(settings.promptFile),
					input: buildOracleInput(params.task, transcript),
					cwd: ctx.cwd,
					tools: settings.tools,
					extensionPaths: settings.extensionPaths,
					skillPaths: settings.skillPaths,
					inheritContext: settings.inheritContext,
					inheritSkills: settings.inheritSkills,
					commandReviewMs: settings.commandReviewMs,
					outputLimitChars: settings.outputLimitChars,
					artifactsBaseDir: runsBaseDir(),
					provenance: mode ? "active-mode" : "inactive-fallback",
					selectionSource: settings.selectionSource,
					usedFallback: settings.usedFallback,
					label: params.task.length > 200 ? `${params.task.slice(0, 200)}…` : params.task,
					onProgress: (progress) => {
						onUpdate?.({
							content: [
								{
									type: "text",
									text: `Oracle running with ${settings.model} (${settings.thinking}) — ${describeProgress(progress)}`,
								},
							],
							details,
						});
					},
					commandOverride,
				},
				signal,
			);
			return run.ok
				? textResult(appendFallbackNote(run.text, settings), { ...details, run })
				: textResult(
						appendFallbackNote(failureText(run.error ?? "Oracle failed", run), settings),
						{ ...details, run },
						true,
					);
		},
	});

	function registerTaskTool(): void {
		pi.registerTool({
			name: "Task",
			label: "Task",
			description:
				"Delegate a bounded task to a fresh isolated worker. Task is primarily for parallel fan-out: when delegated work can split into independent parts, emit multiple Task calls in the same assistant message. Pi Dial does not impose a concurrency limit on those calls. If there is only one ordinary execution task, usually do it directly instead; use a single Task when isolation, a different model or preset, or context containment is the reason to delegate. Long-running commands return control to the worker so it can inspect, wait again, or abort them. Workers cannot communicate or be steered and return only their final summaries. When the dial is inactive, a configured fallback worker runs the task.",
			promptSnippet: "Parallel fan-out to fresh isolated execution workers with configurable models and tools",
			promptGuidelines: [
				"Treat Task as a parallel fan-out tool by default: when delegating decomposable work, issue multiple independent Task calls in the same assistant message. If there is only one ordinary task, do it yourself unless isolation, a different model or preset, or context containment materially helps.",
				"Give Task workers complete bounded briefs because they do not inherit the parent conversation.",
				"Task mode selects a configured worker preset. Omit mode to use the current mode; pass model and/or thinking only for an intentional per-call override.",
				"Fan out only independent work, then inspect and integrate every returned summary yourself.",
			],
			parameters: taskParameters(config.order),
			executionMode: "parallel",
			renderCall(args, theme, context) {
				const route = taskRenderRoutes.get(context.toolCallId);
				const text =
					theme.fg("toolTitle", theme.bold("Task: ")) +
					theme.fg("muted", args.description) +
					theme.fg("dim", route ? ` (${route})` : "");
				return new Text(text, 0, 0);
			},
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				if (configError) {
					return textResult(
						`Pi dial is unavailable: ${configError}`,
						{ kind: "task", mode: activeMode ?? "inactive", description: params.description },
						true,
					);
				}
				let commandOverride: ChildRunRequest["commandOverride"];
				try {
					commandOverride = childCommandOverride();
				} catch (error) {
					return textResult(
						error instanceof Error ? error.message : String(error),
						{ kind: "task", mode: activeMode ?? "inactive", description: params.description },
						true,
					);
				}
				const explicitMode = params.mode;
				const mode = explicitMode ?? activeMode;
				let runMode: string;
				let template: ChildWorkerTemplate;
				let parentModel: Model<Api> | undefined;
				if (mode) {
					const preset = config.modes[mode];
					if (preset.task === false) {
						return textResult(`Task is disabled for dial mode "${mode}".`, { kind: "task", mode }, true);
					}
					const modeResolvedModel = mode === activeMode ? activeModel : resolvePresetModelForChild(preset, ctx);
					runMode = mode;
					parentModel = modeResolvedModel?.model;
					template = childTemplate(preset.task, preset, modeResolvedModel);
				} else {
					const fallback = config.inactive.task;
					if (fallback === false) {
						return textResult(
							`Pi dial is inactive and its inactive Task fallback is disabled. Select a mode with /dial or pass mode. Available: ${config.order.join(", ")}`,
							{ kind: "task", mode: "inactive", description: params.description },
							true,
						);
					}
					runMode = "inactive";
					parentModel = ctx.model;
					template = inactiveChildTemplate(fallback);
				}
				template = applyChildRoute(template, config.childRouting.task, parentModel);
				const resolved = resolveChildTemplate(
					template,
					{ model: params.model && resolveModelRef(config, params.model.trim()), thinking: params.thinking },
					ctx.modelRegistry,
				);
				if (!resolved.settings) {
					return textResult(
						`Task model selection failed: ${resolved.error}`,
						{ kind: "task", mode: runMode, description: params.description },
						true,
					);
				}
				const settings = resolved.settings;
				const details: DialToolDetails = {
					kind: "task",
					mode: runMode,
					model: settings.model,
					thinking: settings.thinking,
					description: params.description,
					selectionSource: settings.selectionSource,
					usedFallback: settings.usedFallback,
				};
				taskRenderRoutes.set(toolCallId, taskRouteLabel(settings.model, settings.thinking));

				onUpdate?.({
					content: [{ type: "text", text: `Task starting with ${settings.model} (${settings.thinking})...` }],
					details,
				});

				try {
					onUpdate?.({
						content: [{ type: "text", text: `Task running with ${settings.model} (${settings.thinking})...` }],
						details,
					});
					const run = await runChildAgent(
						{
							kind: "task",
							mode: runMode,
							model: settings.model,
							thinking: settings.thinking,
							appendSystemPrompt: settings.promptFile && loadPrompt(settings.promptFile),
							input: buildTaskInput(params.description, params.prompt),
							cwd: ctx.cwd,
							tools: settings.tools,
							extensionPaths: settings.extensionPaths,
							skillPaths: settings.skillPaths,
							inheritContext: settings.inheritContext,
							inheritSkills: settings.inheritSkills,
							commandReviewMs: settings.commandReviewMs,
							outputLimitChars: settings.outputLimitChars,
							artifactsBaseDir: runsBaseDir(),
							provenance: explicitMode ? "explicit-mode" : activeMode ? "active-mode" : "inactive-fallback",
							selectionSource: settings.selectionSource,
							usedFallback: settings.usedFallback,
							label: params.description,
							onProgress: (progress) => {
								onUpdate?.({
									content: [
										{
											type: "text",
											text: `Task running with ${settings.model} (${settings.thinking}) — ${describeProgress(progress)}`,
										},
									],
									details,
								});
							},
							commandOverride,
						},
						signal,
					);
					return run.ok
						? textResult(appendFallbackNote(run.text, settings), { ...details, run })
						: textResult(
								appendFallbackNote(failureText(run.error ?? "Task failed", run), settings),
								{ ...details, run },
								true,
							);
				} catch (error) {
					return textResult(error instanceof Error ? error.message : String(error), details, true);
				}
			},
		});
	}
	registerTaskTool();

	pi.on("agent_settled", async (_event, ctx) => {
		if (!pendingMode) return;
		const mode = pendingMode;
		pendingMode = undefined;
		await applyMode(mode, ctx, { notify: true, persist: true });
		updateStatus(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		restoreTaskRenderRoutes(ctx.sessionManager.getBranch());
	});

	const deactivateForIndependentChange = async (ctx: ExtensionContext, reason: string): Promise<void> => {
		if (!activeMode || applyingMode) return;
		activeMode = undefined;
		activeModel = undefined;
		pendingMode = undefined;
		persistState(null);
		await collaboration.sync(ctx);
		updateStatus(ctx);
		ctx.ui.notify(`${reason}; Pi dial is now inactive. Use /dial to reactivate a complete preset.`, "info");
	};

	// Both events also fire, possibly after `applyMode` returns, for the dial's own
	// changes; a selection matching the applied preset state is never an independent change.
	pi.on("model_select", (event, ctx) => {
		if (event.source === "restore") return;
		if (
			activeModel &&
			event.model.provider === activeModel.model.provider &&
			event.model.id === activeModel.model.id
		) {
			return;
		}
		return deactivateForIndependentChange(ctx, "Model changed outside the dial");
	});
	pi.on("thinking_level_select", (event, ctx) => {
		if (activeModel && event.level === activeModel.thinking) return;
		return deactivateForIndependentChange(ctx, "Thinking level changed outside the dial");
	});

	pi.on("session_start", async (_event, ctx) => {
		restoreTaskRenderRoutes(ctx.sessionManager.getBranch());
		activeMode = undefined;
		activeModel = undefined;
		pendingMode = undefined;
		persistedMode = undefined;
		openHud = undefined;
		if (!loadConfiguration(ctx)) return;
		registerConfiguredShortcut(ctx);

		const state = config.persistSelection ? latestState(ctx.sessionManager.getBranch()) : undefined;
		persistedMode = state?.mode;
		const flagMode = String(pi.getFlag("dial") ?? "").trim();
		const explicitParent = process.argv.some(
			(arg) => arg === "--model" || arg === "--provider" || arg === "--thinking",
		);
		if (!flagMode && explicitParent) {
			updateStatus(ctx);
			return;
		}
		const targetMode = flagMode || (state ? (state.mode ?? undefined) : config.defaultMode);
		if (!targetMode) {
			updateStatus(ctx);
			return;
		}
		const activated = await applyMode(targetMode, ctx, { notify: false, persist: !state || Boolean(flagMode) });
		if (!activated.ok) {
			ctx.ui.notify(`Pi dial could not restore mode "${targetMode}". Use /dial status for configuration.`, "error");
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		taskRenderRoutes.clear();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	const collaboration = installNativeCollaboration(pi, {
		...collaborationDependencies,
		enabled: () => !configError && activeMode === "high" && config.modes.high.task !== false,
	});
}
