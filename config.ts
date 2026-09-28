import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";

export type DialModeKey = string;

export interface ModelFallback {
	model: string;
	thinking: ThinkingLevel;
}

export interface ChildAgentConfig {
	model?: string;
	thinking?: ThinkingLevel;
	fallbacks?: ModelFallback[];
	promptFile?: string;
	tools?: string[];
	extensionPaths?: string[];
	skillPaths?: string[];
	inheritContext?: boolean;
	inheritSkills?: boolean;
	/** Load the user's installed extensions in the child. Pi Dial itself stays inactive there. */
	inheritExtensions?: boolean;
	commandReviewMs?: number;
	outputLimitChars?: number;
	maxContextChars?: number;
}

export interface ChildRoute {
	parentModel: string;
	model: string;
	thinking: ThinkingLevel;
}

export interface ChildRoutingConfig {
	oracle: ChildRoute[];
	task: ChildRoute[];
}

export interface InactiveChildConfig extends ChildAgentConfig {
	fallbacks: ModelFallback[];
}

export interface InactiveConfig {
	oracle: InactiveChildConfig | false;
	task: InactiveChildConfig | false;
}

export interface DialPreset {
	label: string;
	description: string;
	color: ThemeColor;
	dial: boolean;
	model: string;
	thinking: ThinkingLevel;
	fallbacks: ModelFallback[];
	oracle: ChildAgentConfig | false;
	task: ChildAgentConfig | false;
}

export interface DialConfig {
	defaultMode: DialModeKey;
	order: DialModeKey[];
	shortcut: KeyId | false;
	hudAutoCloseMs: number | false;
	persistSelection: boolean;
	modes: Record<DialModeKey, DialPreset>;
	inactive: InactiveConfig;
	childRouting: ChildRoutingConfig;
	/** Model aliases, such as `fable`, mapped to provider/model specs. */
	models: Record<string, string>;
	sourceFiles: string[];
}

export interface ConfigPath {
	path: string;
	required?: boolean;
}

export const THINKING_LEVEL_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const DEFAULT_COMMAND_REVIEW_MS = 2 * 60 * 1000;
export const MAX_COMMAND_REVIEW_MS = 2_147_483_647;
const THINKING_LEVELS = new Set<ThinkingLevel>(THINKING_LEVEL_VALUES);
const THEME_COLORS = new Set<ThemeColor>([
	"accent",
	"border",
	"borderAccent",
	"borderMuted",
	"success",
	"error",
	"warning",
	"muted",
	"dim",
	"text",
	"thinkingText",
	"userMessageText",
	"customMessageText",
	"customMessageLabel",
	"toolTitle",
	"toolOutput",
	"mdHeading",
	"mdLink",
	"mdLinkUrl",
	"mdCode",
	"mdCodeBlock",
	"mdCodeBlockBorder",
	"mdQuote",
	"mdQuoteBorder",
	"mdHr",
	"mdListBullet",
	"toolDiffAdded",
	"toolDiffRemoved",
	"toolDiffContext",
	"syntaxComment",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"thinkingMax",
	"bashMode",
]);
const KEY_MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
const SPECIAL_KEYS = new Set([
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageUp",
	"pageDown",
	"up",
	"down",
	"left",
	"right",
	"f1",
	"f2",
	"f3",
	"f4",
	"f5",
	"f6",
	"f7",
	"f8",
	"f9",
	"f10",
	"f11",
	"f12",
]);
const SYMBOL_KEYS = new Set([
	"`",
	"-",
	"=",
	"[",
	"]",
	"\\",
	";",
	"'",
	",",
	".",
	"/",
	"!",
	"@",
	"#",
	"$",
	"%",
	"^",
	"&",
	"*",
	"(",
	")",
	"_",
	"+",
	"|",
	"~",
	"{",
	"}",
	":",
	"<",
	">",
	"?",
]);
const TOP_LEVEL_KEYS = new Set([
	"defaultMode",
	"order",
	"shortcut",
	"hudAutoCloseMs",
	"persistSelection",
	"modes",
	"inactive",
	"childRouting",
	"models",
]);
const PRESET_KEYS = new Set([
	"label",
	"description",
	"color",
	"dial",
	"model",
	"thinking",
	"fallbacks",
	"oracle",
	"task",
]);
const SHARED_CHILD_KEYS = [
	"model",
	"thinking",
	"fallbacks",
	"promptFile",
	"tools",
	"extensionPaths",
	"skillPaths",
	"inheritContext",
	"inheritSkills",
	"inheritExtensions",
	"outputLimitChars",
];
const ORACLE_CHILD_KEYS = new Set([...SHARED_CHILD_KEYS, "maxContextChars"]);
const TASK_CHILD_KEYS = new Set([...SHARED_CHILD_KEYS, "commandReviewMs"]);
const INACTIVE_SHARED_KEYS = SHARED_CHILD_KEYS.filter((key) => key !== "model" && key !== "thinking");
const INACTIVE_ORACLE_KEYS = new Set([...INACTIVE_SHARED_KEYS, "maxContextChars"]);
const INACTIVE_TASK_KEYS = new Set([...INACTIVE_SHARED_KEYS, "commandReviewMs"]);
const REMOVED_PROMPT_KEYS = new Set(["parentPrompt", "includeRuntimeContext"]);
const REMOVED_TIMEOUT_KEYS = new Set(["timeoutMs", "timeoutRecoveryMs", "maxTimeoutMs"]);

function promptPath(extensionDir: string, name: string): string {
	return join(extensionDir, "prompts", name);
}

function createTaskConfig(): ChildAgentConfig {
	return {
		tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
		inheritContext: true,
		inheritSkills: true,
		commandReviewMs: DEFAULT_COMMAND_REVIEW_MS,
		outputLimitChars: 50_000,
	};
}

function createOracleDefaults(extensionDir: string): ChildAgentConfig {
	return {
		promptFile: promptPath(extensionDir, "oracle.md"),
		// agent-default (not a user rule): 2026-09-28 — Pi's normal tools minus edit/write; bash allows git inspection.
		tools: ["read", "bash", "grep", "find", "ls"],
		inheritContext: true,
		inheritSkills: true,
		outputLimitChars: 50_000,
		maxContextChars: 120_000,
	};
}

function createOracleConfig(extensionDir: string, model: string): ChildAgentConfig {
	return { model, thinking: "high", ...createOracleDefaults(extensionDir) };
}

/** Built-in defaults with model aliases unresolved, so higher layers can remap an alias. */
function createDefaultLayer(extensionDir: string): DialConfig {
	return {
		defaultMode: "medium",
		order: ["low", "medium", "high", "ultra"],
		shortcut: "ctrl+shift+u",
		hudAutoCloseMs: 2400,
		persistSelection: true,
		modes: {
			low: {
				label: "Low",
				description: "Opus with moderate reasoning",
				color: "success",
				dial: true,
				model: "opus",
				thinking: "medium",
				fallbacks: [],
				oracle: createOracleConfig(extensionDir, "astra"),
				task: createTaskConfig(),
			},
			medium: {
				label: "Medium",
				description: "Balanced default",
				color: "accent",
				dial: true,
				model: "sol",
				thinking: "medium",
				fallbacks: [],
				oracle: createOracleConfig(extensionDir, "astra"),
				task: createTaskConfig(),
			},
			high: {
				label: "High",
				description: "Maximum Sol reasoning with a Fable second opinion",
				color: "thinkingHigh",
				dial: true,
				model: "sol",
				thinking: "xhigh",
				fallbacks: [],
				oracle: createOracleConfig(extensionDir, "fable"),
				task: createTaskConfig(),
			},
			ultra: {
				label: "Ultra",
				description: "Fable-led implementation with a Sol second opinion",
				color: "thinkingMax",
				dial: true,
				model: "fable",
				thinking: "high",
				fallbacks: [],
				oracle: createOracleConfig(extensionDir, "sol"),
				task: createTaskConfig(),
			},
		},
		inactive: {
			oracle: {
				fallbacks: [
					{ model: "fable", thinking: "high" },
					{ model: "sol", thinking: "xhigh" },
				],
				...createOracleDefaults(extensionDir),
			},
			task: {
				fallbacks: [{ model: "sol", thinking: "medium" }],
				...createTaskConfig(),
			},
		},
		childRouting: {
			oracle: [],
			task: [],
		},
		models: {
			opus: "anthropic/claude-opus-5-5",
			sol: "openai-codex/gpt-6-sol",
			astra: "openai-codex/gpt-6-astra",
			fable: "anthropic/claude-fable-5-1",
		},
		sourceFiles: [],
	};
}

export function createDefaultConfig(extensionDir: string): DialConfig {
	return resolveModelAliases(createDefaultLayer(extensionDir));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownKeys(value: Record<string, unknown>, allowed: Set<string>, location: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`${location}: unknown property "${key}"`);
	}
}

function readModeKey(value: string, location: string): string {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) {
		throw new Error(`${location}: expected a mode key containing only letters, numbers, hyphens, or underscores`);
	}
	return value;
}

function readString(value: unknown, location: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${location}: expected a non-empty string`);
	}
	return value.trim();
}

function readBoolean(value: unknown, location: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${location}: expected a boolean`);
	return value;
}

function readPositiveInteger(value: unknown, location: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${location}: expected a positive integer`);
	}
	return value;
}

function readThinking(value: unknown, location: string): ThinkingLevel {
	if (typeof value !== "string" || !THINKING_LEVELS.has(value as ThinkingLevel)) {
		throw new Error(`${location}: expected one of ${[...THINKING_LEVELS].join(", ")}`);
	}
	return value as ThinkingLevel;
}

function readThemeColor(value: unknown, location: string): ThemeColor {
	if (typeof value !== "string" || !THEME_COLORS.has(value as ThemeColor)) {
		throw new Error(`${location}: expected a Pi theme color name, for example "accent" or "thinkingHigh"`);
	}
	return value as ThemeColor;
}

function readStringArray(value: unknown, location: string, allowEmpty = true): string[] {
	if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
		throw new Error(`${location}: expected ${allowEmpty ? "an" : "a non-empty"} array of strings`);
	}
	return value.map((item, index) => readString(item, `${location}[${index}]`));
}

function resolveConfigPath(value: unknown, baseDir: string, location: string): string {
	const filePath = readString(value, location);
	return isAbsolute(filePath) ? filePath : resolve(baseDir, filePath);
}

function isKeyId(value: string): value is KeyId {
	let base = value;
	const modifiers = new Set<string>();
	while (true) {
		const separator = base.indexOf("+");
		if (separator < 0) break;
		const modifier = base.slice(0, separator);
		if (!KEY_MODIFIERS.has(modifier) || modifiers.has(modifier)) break;
		modifiers.add(modifier);
		base = base.slice(separator + 1);
	}
	return (
		/^[a-z0-9]$/.test(base) || SPECIAL_KEYS.has(base) || SYMBOL_KEYS.has(base)
	);
}

const MODEL_ALIAS_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function readProviderModel(value: unknown, location: string): string {
	const spec = readString(value, location);
	const separator = spec.indexOf("/");
	if (separator <= 0 || separator === spec.length - 1) {
		throw new Error(`${location}: expected provider/model`);
	}
	return spec;
}

/** A provider/model spec, or a model alias resolved after all layers merge. */
function readModelSpec(value: unknown, location: string): string {
	const spec = readString(value, location);
	if (MODEL_ALIAS_PATTERN.test(spec)) return spec;
	return readProviderModel(spec, location);
}

function resolveModelAliases(config: DialConfig): DialConfig {
	const resolveRef = (ref: string, location: string): string => {
		if (!MODEL_ALIAS_PATTERN.test(ref)) return ref;
		const spec = config.models[ref];
		if (spec === undefined) {
			throw new Error(`${location}: unknown model alias "${ref}"; define it under "models" or use provider/model`);
		}
		return spec;
	};
	const resolveFallbacks = (fallbacks: ModelFallback[], location: string): ModelFallback[] =>
		fallbacks.map((fallback, index) => ({
			...fallback,
			model: resolveRef(fallback.model, `${location}[${index}].model`),
		}));
	const resolveChild = <T extends ChildAgentConfig>(child: T | false, location: string): T | false => {
		if (child === false) return false;
		const next = { ...child };
		if (next.model !== undefined) next.model = resolveRef(next.model, `${location}.model`);
		if (next.fallbacks !== undefined) next.fallbacks = resolveFallbacks(next.fallbacks, `${location}.fallbacks`);
		return next;
	};
	const modes: Record<DialModeKey, DialPreset> = {};
	for (const [mode, preset] of Object.entries(config.modes)) {
		const location = `modes.${mode}`;
		modes[mode] = {
			...preset,
			model: resolveRef(preset.model, `${location}.model`),
			fallbacks: resolveFallbacks(preset.fallbacks, `${location}.fallbacks`),
			oracle: resolveChild(preset.oracle, `${location}.oracle`),
			task: resolveChild(preset.task, `${location}.task`),
		};
	}
	const resolveRoutes = (routes: ChildRoute[], location: string): ChildRoute[] =>
		routes.map((route, index) => ({
			...route,
			parentModel: resolveRef(route.parentModel, `${location}[${index}].parentModel`),
			model: resolveRef(route.model, `${location}[${index}].model`),
		}));
	return {
		...config,
		modes,
		inactive: {
			oracle: resolveChild(config.inactive.oracle, "inactive.oracle"),
			task: resolveChild(config.inactive.task, "inactive.task"),
		},
		childRouting: {
			oracle: resolveRoutes(config.childRouting.oracle, "childRouting.oracle"),
			task: resolveRoutes(config.childRouting.task, "childRouting.task"),
		},
	};
}

/** Resolves a per-call model override: a configured alias or a provider/model spec. */
export function resolveModelRef(config: DialConfig, ref: string): string {
	return config.models[ref] ?? ref;
}

function mergeFallbacks(value: unknown, location: string): ModelFallback[] {
	if (!Array.isArray(value)) throw new Error(`${location}: expected an array`);
	return value.map((item, index) => {
		const itemLocation = `${location}[${index}]`;
		if (!isRecord(item)) throw new Error(`${itemLocation}: expected an object`);
		assertKnownKeys(item, new Set(["model", "thinking"]), itemLocation);
		return {
			model: readModelSpec(item.model, `${itemLocation}.model`),
			thinking: readThinking(item.thinking, `${itemLocation}.thinking`),
		};
	});
}

function mergeChildConfig(
	base: ChildAgentConfig | false | undefined,
	value: unknown,
	baseDir: string,
	location: string,
	allowedKeys: Set<string>,
): ChildAgentConfig | false {
	if (value === false) return false;
	if (!isRecord(value)) throw new Error(`${location}: expected an object or false`);
	for (const key of Object.keys(value)) {
		if (REMOVED_TIMEOUT_KEYS.has(key)) {
			throw new Error(
				`${location}.${key}: whole-agent timeouts were removed; delete this key and set task.commandReviewMs to control when a long Bash command returns control`,
			);
		}
	}
	assertKnownKeys(value, allowedKeys, location);
	const next: ChildAgentConfig = base === false || base === undefined ? {} : { ...base };

	if (value.model !== undefined) next.model = readModelSpec(value.model, `${location}.model`);
	if (value.thinking !== undefined) next.thinking = readThinking(value.thinking, `${location}.thinking`);
	if (value.fallbacks !== undefined) next.fallbacks = mergeFallbacks(value.fallbacks, `${location}.fallbacks`);
	if (value.promptFile !== undefined) {
		next.promptFile = resolveConfigPath(value.promptFile, baseDir, `${location}.promptFile`);
	}
	if (value.tools !== undefined) next.tools = readStringArray(value.tools, `${location}.tools`);
	if (value.extensionPaths !== undefined) {
		next.extensionPaths = readStringArray(value.extensionPaths, `${location}.extensionPaths`).map((filePath) =>
			isAbsolute(filePath) ? filePath : resolve(baseDir, filePath),
		);
	}
	if (value.skillPaths !== undefined) {
		next.skillPaths = readStringArray(value.skillPaths, `${location}.skillPaths`).map((filePath) =>
			isAbsolute(filePath) ? filePath : resolve(baseDir, filePath),
		);
	}
	if (value.inheritContext !== undefined) {
		next.inheritContext = readBoolean(value.inheritContext, `${location}.inheritContext`);
	}
	if (value.inheritSkills !== undefined) {
		next.inheritSkills = readBoolean(value.inheritSkills, `${location}.inheritSkills`);
	}
	if (value.inheritExtensions !== undefined) {
		next.inheritExtensions = readBoolean(value.inheritExtensions, `${location}.inheritExtensions`);
	}
	for (const key of ["commandReviewMs", "outputLimitChars", "maxContextChars"] as const) {
		if (value[key] === undefined) continue;
		const parsed = readPositiveInteger(value[key], `${location}.${key}`);
		if (key === "commandReviewMs" && parsed > MAX_COMMAND_REVIEW_MS) {
			throw new Error(`${location}.${key}: must not exceed ${MAX_COMMAND_REVIEW_MS}`);
		}
		next[key] = parsed;
	}
	return next;
}

function mergeInactiveChild(
	base: InactiveChildConfig,
	value: unknown,
	baseDir: string,
	location: string,
	allowedKeys: Set<string>,
): InactiveChildConfig | false {
	return mergeChildConfig(base, value, baseDir, location, allowedKeys) as InactiveChildConfig | false;
}

function mergePreset(
	base: DialPreset | undefined,
	value: unknown,
	baseDir: string,
	location: string,
): DialPreset {
	if (!isRecord(value)) throw new Error(`${location}: expected an object`);
	if ("tools" in value || "optionalTools" in value) {
		throw new Error(
			`${location}: the dial never manages the main agent's tool loadout; remove "tools"/"optionalTools" (oracle.tools and task.tools still configure child agents)`,
		);
	}
	if ("promptFile" in value) {
		throw new Error(
			`${location}.promptFile: mode prompts were removed; Pi Dial keeps Pi's system prompt. Delete this key, or use oracle.promptFile/task.promptFile to add child instructions`,
		);
	}
	assertKnownKeys(value, PRESET_KEYS, location);
	const next: Partial<DialPreset> = base
		? {
				...base,
				fallbacks: base.fallbacks.map((fallback) => ({ ...fallback })),
				oracle: base.oracle === false ? false : { ...base.oracle },
				task: base.task === false ? false : { ...base.task },
			}
		: {};

	if (value.label !== undefined) next.label = readString(value.label, `${location}.label`);
	if (value.description !== undefined) {
		next.description = readString(value.description, `${location}.description`);
	}
	if (value.color !== undefined) next.color = readThemeColor(value.color, `${location}.color`);
	if (value.dial !== undefined) next.dial = readBoolean(value.dial, `${location}.dial`);
	if (value.model !== undefined) next.model = readModelSpec(value.model, `${location}.model`);
	if (value.thinking !== undefined) next.thinking = readThinking(value.thinking, `${location}.thinking`);
	if (value.fallbacks !== undefined) next.fallbacks = mergeFallbacks(value.fallbacks, `${location}.fallbacks`);
	if (value.oracle !== undefined) {
		next.oracle = mergeChildConfig(base?.oracle, value.oracle, baseDir, `${location}.oracle`, ORACLE_CHILD_KEYS);
	}
	if (value.task !== undefined) {
		next.task = mergeChildConfig(base?.task, value.task, baseDir, `${location}.task`, TASK_CHILD_KEYS);
	}

	const { label, description, model, thinking } = next;
	if (label === undefined) throw new Error(`${location}.label: required for a new mode`);
	if (description === undefined) throw new Error(`${location}.description: required for a new mode`);
	if (model === undefined) throw new Error(`${location}.model: required for a new mode`);
	if (thinking === undefined) throw new Error(`${location}.thinking: required for a new mode`);
	return {
		label,
		description,
		color: next.color ?? "accent",
		dial: next.dial ?? true,
		model,
		thinking,
		fallbacks: next.fallbacks ?? [],
		oracle: next.oracle ?? false,
		task: next.task ?? false,
	};
}

function applyLayer(config: DialConfig, layer: unknown, filePath: string, extensionDir: string): DialConfig {
	if (!isRecord(layer)) throw new Error(`${filePath}: expected a JSON object`);
	for (const key of Object.keys(layer)) {
		if (REMOVED_PROMPT_KEYS.has(key)) {
			throw new Error(`${filePath}.${key}: mode prompts were removed; Pi Dial keeps Pi's system prompt. Delete this key`);
		}
	}
	assertKnownKeys(layer, TOP_LEVEL_KEYS, filePath);
	const baseDir = dirname(filePath);
	const next: DialConfig = {
		...config,
		order: [...config.order],
		modes: { ...config.modes },
		childRouting: { ...config.childRouting },
		models: { ...config.models },
		sourceFiles: [...config.sourceFiles, filePath],
	};

	if (layer.defaultMode !== undefined) {
		next.defaultMode = readModeKey(readString(layer.defaultMode, `${filePath}.defaultMode`), `${filePath}.defaultMode`);
	}
	if (layer.order !== undefined) {
		next.order = readStringArray(layer.order, `${filePath}.order`, false).map((mode, index) =>
			readModeKey(mode, `${filePath}.order[${index}]`),
		);
	}
	if (layer.shortcut !== undefined) {
		if (layer.shortcut === false) next.shortcut = false;
		else {
			const shortcut = readString(layer.shortcut, `${filePath}.shortcut`);
			if (!isKeyId(shortcut)) throw new Error(`${filePath}.shortcut: invalid Pi key identifier "${shortcut}"`);
			next.shortcut = shortcut;
		}
	}
	if (layer.hudAutoCloseMs !== undefined) {
		if (layer.hudAutoCloseMs === false) next.hudAutoCloseMs = false;
		else next.hudAutoCloseMs = readPositiveInteger(layer.hudAutoCloseMs, `${filePath}.hudAutoCloseMs`);
	}
	if (layer.persistSelection !== undefined) {
		next.persistSelection = readBoolean(layer.persistSelection, `${filePath}.persistSelection`);
	}
	if (layer.modes !== undefined) {
		if (!isRecord(layer.modes)) throw new Error(`${filePath}.modes: expected an object`);
		for (const [mode, preset] of Object.entries(layer.modes)) {
			readModeKey(mode, `${filePath}.modes key`);
			next.modes[mode] = mergePreset(next.modes[mode], preset, baseDir, `${filePath}.modes.${mode}`);
		}
	}
	if (layer.models !== undefined) {
		if (!isRecord(layer.models)) throw new Error(`${filePath}.models: expected an object`);
		for (const [alias, spec] of Object.entries(layer.models)) {
			if (!MODEL_ALIAS_PATTERN.test(alias)) {
				throw new Error(`${filePath}.models: alias "${alias}" may contain only letters, numbers, dots, hyphens, or underscores`);
			}
			next.models[alias] = readProviderModel(spec, `${filePath}.models.${alias}`);
		}
	}
	if (layer.childRouting !== undefined) {
		if (!isRecord(layer.childRouting)) throw new Error(`${filePath}.childRouting: expected an object`);
		assertKnownKeys(layer.childRouting, new Set(["oracle", "task"]), `${filePath}.childRouting`);
		for (const kind of ["oracle", "task"] as const) {
			const value = layer.childRouting[kind];
			if (value === undefined) continue;
			if (!Array.isArray(value)) throw new Error(`${filePath}.childRouting.${kind}: expected an array`);
			next.childRouting[kind] = value.map((item, index) => {
				const location = `${filePath}.childRouting.${kind}[${index}]`;
				if (!isRecord(item)) throw new Error(`${location}: expected an object`);
				assertKnownKeys(item, new Set(["parentModel", "model", "thinking"]), location);
				return {
					parentModel: readModelSpec(item.parentModel, `${location}.parentModel`),
					model: readModelSpec(item.model, `${location}.model`),
					thinking: readThinking(item.thinking, `${location}.thinking`),
				};
			});
		}
	}
	if (layer.inactive !== undefined) {
		if (!isRecord(layer.inactive)) throw new Error(`${filePath}.inactive: expected an object`);
		assertKnownKeys(layer.inactive, new Set(["oracle", "task"]), `${filePath}.inactive`);
		const defaultInactive = createDefaultLayer(extensionDir).inactive;
		const inactive = { ...next.inactive };
		if (layer.inactive.oracle !== undefined) {
			inactive.oracle = mergeInactiveChild(
				next.inactive.oracle === false ? (defaultInactive.oracle as InactiveChildConfig) : next.inactive.oracle,
				layer.inactive.oracle,
				baseDir,
				`${filePath}.inactive.oracle`,
				INACTIVE_ORACLE_KEYS,
			);
		}
		if (layer.inactive.task !== undefined) {
			inactive.task = mergeInactiveChild(
				next.inactive.task === false ? (defaultInactive.task as InactiveChildConfig) : next.inactive.task,
				layer.inactive.task,
				baseDir,
				`${filePath}.inactive.task`,
				INACTIVE_TASK_KEYS,
			);
		}
		next.inactive = inactive;
	}
	return next;
}

function assertExistingPath(filePath: string, location: string): void {
	if (!existsSync(filePath)) throw new Error(`${location}: path does not exist: ${filePath}`);
}

function assertReadableFile(filePath: string, location: string): void {
	assertExistingPath(filePath, location);
	try {
		readFileSync(filePath, "utf8");
	} catch (error) {
		throw new Error(`${location}: cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function assertPromptFile(filePath: string, location: string): void {
	assertReadableFile(filePath, location);
	try {
		loadPrompt(filePath);
	} catch (error) {
		throw new Error(`${location}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function validateChild(config: ChildAgentConfig | false, location: string): void {
	if (config === false) return;
	if (config.model !== undefined) readModelSpec(config.model, `${location}.model`);
	if (config.promptFile !== undefined) assertPromptFile(config.promptFile, `${location}.promptFile`);
	for (const [index, filePath] of (config.extensionPaths ?? []).entries()) {
		assertExistingPath(filePath, `${location}.extensionPaths[${index}]`);
	}
	for (const [index, filePath] of (config.skillPaths ?? []).entries()) {
		assertExistingPath(filePath, `${location}.skillPaths[${index}]`);
	}
}

function validateConfig(config: DialConfig): DialConfig {
	if (!config.modes[config.defaultMode]) {
		throw new Error(`defaultMode: unknown mode "${config.defaultMode}"`);
	}
	const seen = new Set<string>();
	for (const mode of config.order) {
		if (seen.has(mode)) throw new Error(`order: duplicate mode "${mode}"`);
		if (!config.modes[mode]) throw new Error(`order: unknown mode "${mode}"`);
		seen.add(mode);
	}
	for (const mode of Object.keys(config.modes)) {
		if (!seen.has(mode)) config.order.push(mode);
		const preset = config.modes[mode];
		validateChild(preset.oracle, `modes.${mode}.oracle`);
		validateChild(preset.task, `modes.${mode}.task`);
	}
	if (!config.order.some((mode) => config.modes[mode].dial)) {
		throw new Error(`modes: at least one mode must stay on the dial ("dial": true)`);
	}
	validateInactiveChild(config.inactive.oracle, "inactive.oracle");
	validateInactiveChild(config.inactive.task, "inactive.task");
	return config;
}

function validateInactiveChild(config: InactiveChildConfig | false, location: string): void {
	if (config === false) return;
	if (config.fallbacks.length === 0) {
		throw new Error(`${location}.fallbacks: at least one fallback model is required`);
	}
	for (const [index, fallback] of config.fallbacks.entries()) {
		readModelSpec(fallback.model, `${location}.fallbacks[${index}].model`);
	}
	validateChild(config, location);
}

export function loadDialConfig(extensionDir: string, paths: ConfigPath[]): DialConfig {
	let config = createDefaultLayer(extensionDir);
	for (const candidate of paths) {
		if (!existsSync(candidate.path)) {
			if (candidate.required) throw new Error(`Config file does not exist: ${candidate.path}`);
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(candidate.path, "utf8"));
		} catch (error) {
			throw new Error(
				`Failed to parse ${candidate.path}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		config = applyLayer(config, parsed, candidate.path, extensionDir);
	}
	return validateConfig(resolveModelAliases(config));
}

export function splitModelSpec(spec: string): { provider: string; modelId: string } {
	const separator = spec.indexOf("/");
	if (separator <= 0 || separator === spec.length - 1) throw new Error(`Invalid model spec: ${spec}`);
	return { provider: spec.slice(0, separator), modelId: spec.slice(separator + 1) };
}

export function loadPrompt(filePath: string): string {
	const prompt = readFileSync(filePath, "utf8").trim();
	if (!prompt) throw new Error(`Prompt file is empty: ${filePath}`);
	return prompt;
}
