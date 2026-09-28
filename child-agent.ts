import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type ChildAgentKind = "oracle" | "task";

export type ChildRunProvenance = "active-mode" | "explicit-mode" | "inactive-fallback";

/** On-disk forensic artifacts for one child run. Nothing here is ever auto-deleted mid-run. */
export interface RunArtifacts {
	dir: string;
	inputPath: string;
	sessionPath: string;
	eventsPath: string;
	stderrPath: string;
	metaPath: string;
}

/** Live progress derived from the child's streamed JSON events. */
export interface ChildRunProgress {
	artifactsDir: string;
	toolCalls: number;
	assistantTurns: number;
	lastTool?: string;
}

export interface RunRetentionPolicy {
	/** Keep at most this many run directories (newest first). */
	maxRuns: number;
	/** Remove run directories whose mtime is older than this. */
	maxAgeMs: number;
	/** Never remove run directories younger than this, protecting concurrent in-flight runs. */
	minAgeMs: number;
}

export const DEFAULT_RUN_RETENTION: RunRetentionPolicy = {
	maxRuns: 60,
	maxAgeMs: 14 * 24 * 60 * 60 * 1000,
	minAgeMs: 60 * 60 * 1000,
};

export type ChildSelectionSource =
	| "per-call"
	| "parent-model-route"
	| "child-config"
	| "parent-inheritance"
	| "inactive-fallback";

export interface ChildRunRequest {
	kind: ChildAgentKind;
	mode: string;
	model: string;
	thinking: ThinkingLevel;
	/** Role instructions appended to Pi's normal system prompt. */
	appendSystemPrompt?: string;
	input: string;
	cwd: string;
	tools: string[];
	extensionPaths: string[];
	skillPaths: string[];
	inheritContext: boolean;
	inheritSkills: boolean;
	commandReviewMs: number;
	outputLimitChars: number;
	artifactsBaseDir: string;
	provenance: ChildRunProvenance;
	selectionSource?: ChildSelectionSource;
	usedFallback?: boolean;
	label?: string;
	onProgress?: (progress: ChildRunProgress) => void;
	commandOverride?: { command: string; prefixArgs?: string[] };
}

export interface ChildRunResult {
	ok: boolean;
	kind: ChildAgentKind;
	mode: string;
	model: string;
	thinking: ThinkingLevel;
	text: string;
	exitCode: number | null;
	signalCode?: NodeJS.Signals;
	durationMs: number;
	aborted: boolean;
	stderr: string;
	stopReason?: string;
	error?: string;
	artifacts?: RunArtifacts;
}

interface JsonMessageEvent {
	type?: unknown;
	message?: unknown;
	toolName?: unknown;
}

const RUN_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(?:oracle|task)-[0-9a-f]{6}$/;
const ACTIVE_RUN_FILE = ".active.json";
const CACHE_AFFINITY_EXTENSION = join(dirname(fileURLToPath(import.meta.url)), "cache-affinity.ts");
const COMMAND_SUPERVISOR_EXTENSION = join(dirname(fileURLToPath(import.meta.url)), "command-supervisor.ts");
const CACHE_KEY_ENV = "PI_DIAL_PROMPT_CACHE_KEY";
const COMMAND_REVIEW_ENV = "PI_DIAL_COMMAND_REVIEW_MS";
const RUN_DIR_ENV = "PI_DIAL_RUN_DIR";
const DEFAULT_TERMINATION_GRACE_MS = 2_000;
const DEFAULT_TERMINATION_SETTLE_MS = 1_000;

/**
 * Stable across workers with the same static prompt/tool configuration, while deliberately
 * excluding the delegated input so OpenAI can reuse the shared prefix between fresh runs.
 */
export function childPromptCacheKey(request: ChildRunRequest): string {
	const staticConfiguration = JSON.stringify({
		kind: request.kind,
		model: request.model,
		appendSystemPrompt: request.appendSystemPrompt,
		tools: request.tools,
		extensionPaths: request.extensionPaths,
		skillPaths: request.skillPaths,
		inheritContext: request.inheritContext,
		inheritSkills: request.inheritSkills,
		...(request.tools.includes("bash") ? { commandReviewMs: request.commandReviewMs } : {}),
	});
	const digest = createHash("sha256").update(staticConfiguration).digest("hex").slice(0, 32);
	return `pi-dial-${request.kind}-${digest}`;
}

function runDirName(kind: ChildAgentKind, startedAt: number): string {
	const timestamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
	return `${timestamp}-${kind}-${randomBytes(3).toString("hex")}`;
}

export async function createRunArtifacts(
	baseDir: string,
	kind: ChildAgentKind,
	startedAt = Date.now(),
): Promise<RunArtifacts> {
	const dir = join(baseDir, runDirName(kind, startedAt));
	await mkdir(dir, { recursive: true, mode: 0o700 });
	return {
		dir,
		inputPath: join(dir, "input.md"),
		sessionPath: join(dir, "session.jsonl"),
		eventsPath: join(dir, "events.jsonl"),
		stderrPath: join(dir, "stderr.log"),
		metaPath: join(dir, "meta.json"),
	};
}

async function hasLiveRunOwner(runDir: string): Promise<boolean> {
	let pid: unknown;
	try {
		pid = (JSON.parse(await readFile(join(runDir, ACTIVE_RUN_FILE), "utf8")) as { pid?: unknown }).pid;
	} catch {
		return false;
	}
	if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Bounded retention for run directories: drop runs older than `maxAgeMs`, then keep at most
 * `maxRuns` newest. Directories younger than `minAgeMs` are never touched so concurrent runs
 * cannot be pruned mid-flight, and only names matching the run pattern are considered.
 * Best-effort: per-directory failures (including prune races) are swallowed.
 */
export async function pruneRunArtifacts(
	baseDir: string,
	retention: RunRetentionPolicy = DEFAULT_RUN_RETENTION,
	now = Date.now(),
): Promise<string[]> {
	let names: string[];
	try {
		names = await readdir(baseDir);
	} catch {
		return [];
	}
	const candidates: Array<{ name: string; mtimeMs: number }> = [];
	for (const name of names) {
		if (!RUN_DIR_PATTERN.test(name)) continue;
		try {
			const runDir = join(baseDir, name);
			const info = await stat(runDir);
			if (await hasLiveRunOwner(runDir)) continue;
			if (info.isDirectory()) candidates.push({ name, mtimeMs: info.mtimeMs });
		} catch {
			// Raced with another prune or an external delete; skip.
		}
	}
	candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const removed: string[] = [];
	for (const [index, candidate] of candidates.entries()) {
		const age = now - candidate.mtimeMs;
		if (age < retention.minAgeMs) continue;
		if (age <= retention.maxAgeMs && index < retention.maxRuns) continue;
		try {
			await rm(join(baseDir, candidate.name), { recursive: true, force: true });
			removed.push(candidate.name);
		} catch {
			// Best-effort; a concurrent prune may have removed it already.
		}
	}
	return removed;
}

interface AssistantLike {
	role: "assistant";
	content: Array<{ type?: unknown; text?: unknown }>;
	stopReason?: unknown;
	errorMessage?: unknown;
}

function isAssistantLike(value: unknown): value is AssistantLike {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return candidate.role === "assistant" && Array.isArray(candidate.content);
}

function assistantText(message: AssistantLike): string {
	return message.content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n")
		.trim();
}

function truncateOutput(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n\n[Child output truncated: ${text.length - limit} characters omitted]`;
}

export function resolveChildInvocation(
	args: string[],
	override: ChildRunRequest["commandOverride"],
	execPath = process.execPath,
	entrypoint = process.argv[1],
): { command: string; args: string[] } {
	if (override) return { command: override.command, args: [...(override.prefixArgs ?? []), ...args] };

	const executable = basename(execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: execPath, args };
	const supportedEntrypoint = entrypoint && /\.(?:cjs|js|mjs)$/.test(entrypoint) && existsSync(entrypoint);
	if (supportedEntrypoint) return { command: execPath, args: [entrypoint, ...args] };
	return { command: "pi", args };
}

function closeStream(stream: NodeJS.WritableStream): Promise<void> {
	return new Promise<void>((resolveClose) => stream.end(() => resolveClose()));
}

export async function runChildAgent(request: ChildRunRequest, signal?: AbortSignal): Promise<ChildRunResult> {
	const startedAt = Date.now();
	const baseResult = {
		kind: request.kind,
		mode: request.mode,
		model: request.model,
		thinking: request.thinking,
	} as const;

	let artifacts: RunArtifacts;
	try {
		artifacts = await createRunArtifacts(request.artifactsBaseDir, request.kind, startedAt);
		await writeFile(artifacts.inputPath, request.input, { encoding: "utf8", mode: 0o600 });
		await writeFile(join(artifacts.dir, ACTIVE_RUN_FILE), `${JSON.stringify({ pid: process.pid })}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
	} catch (error) {
		return {
			...baseResult,
			ok: false,
			text: "",
			exitCode: -1,
			durationMs: Date.now() - startedAt,
			aborted: false,
			stderr: "",
			error: `Could not create run artifacts under ${request.artifactsBaseDir}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	void pruneRunArtifacts(request.artifactsBaseDir).catch(() => {});

	const meta: Record<string, unknown> = {
		version: 1,
		kind: request.kind,
		mode: request.mode,
		provenance: request.provenance,
		...(request.selectionSource ? { selectionSource: request.selectionSource } : {}),
		...(request.usedFallback ? { usedFallback: true } : {}),
		...(request.label ? { label: request.label } : {}),
		model: request.model,
		thinking: request.thinking,
		cwd: request.cwd,
		tools: request.tools,
		promptCacheKey: childPromptCacheKey(request),
		commandReviewMs: request.commandReviewMs,
		startedAt: new Date(startedAt).toISOString(),
		status: "running",
	};
	const writeMeta = async (): Promise<void> => {
		try {
			await writeFile(artifacts.metaPath, `${JSON.stringify(meta, null, "\t")}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
		} catch {
			// Forensics must never fail the run itself.
		}
	};
	await writeMeta();

	const eventsStream = createWriteStream(artifacts.eventsPath, { flags: "a", mode: 0o600 });
	const stderrStream = createWriteStream(artifacts.stderrPath, { flags: "a", mode: 0o600 });
	const progress: ChildRunProgress = { artifactsDir: artifacts.dir, toolCalls: 0, assistantTurns: 0 };
	request.onProgress?.({ ...progress });

	let finalText = "";
	let stopReason: string | undefined;
	let modelError: string | undefined;
	let stderr = "";
	let aborted = false;

	try {
		const processLine = (line: string) => {
			if (!line.trim()) return;
			eventsStream.write(`${line}\n`);
			let event: JsonMessageEvent;
			try {
				event = JSON.parse(line) as JsonMessageEvent;
			} catch {
				return;
			}
			if (event.type === "tool_execution_start") {
				progress.toolCalls++;
				if (typeof event.toolName === "string") progress.lastTool = event.toolName;
				request.onProgress?.({ ...progress });
				return;
			}
			if (event.type !== "message_end" || !isAssistantLike(event.message)) return;
			const text = assistantText(event.message);
			progress.assistantTurns++;
			if (text) finalText = text;
			if (typeof event.message.stopReason === "string") stopReason = event.message.stopReason;
			if (typeof event.message.errorMessage === "string") modelError = event.message.errorMessage;
			request.onProgress?.({ ...progress });
		};

		const supervisedCommands = request.tools.includes("bash");
		const activeTools = supervisedCommands
			? [...new Set([...request.tools, "command_session"])]
			: request.tools;
		const args = [
			"--mode",
			"json",
			"--print",
			"--session",
			artifacts.sessionPath,
			"--no-extensions",
			"--no-prompt-templates",
			"--no-themes",
			"--model",
			request.model,
			"--thinking",
			request.thinking,
		];
		if (request.appendSystemPrompt) args.push("--append-system-prompt", request.appendSystemPrompt);
		if (!request.inheritContext) args.push("--no-context-files");
		if (!request.inheritSkills) args.push("--no-skills");
		if (activeTools.length === 0) args.push("--no-tools");
		else args.push("--tools", activeTools.join(","));
		args.push("--extension", CACHE_AFFINITY_EXTENSION);
		if (supervisedCommands) args.push("--extension", COMMAND_SUPERVISOR_EXTENSION);
		for (const extensionPath of request.extensionPaths) args.push("--extension", extensionPath);
		for (const skillPath of request.skillPaths) args.push("--skill", skillPath);
		args.push(`@${artifacts.inputPath}`, "Complete the delegated task in the attached text file.");

		const invocation = resolveChildInvocation(args, request.commandOverride);
		const child = spawn(invocation.command, invocation.args, {
			cwd: request.cwd,
			detached: process.platform !== "win32",
			env: {
				...process.env,
				[CACHE_KEY_ENV]: childPromptCacheKey(request),
				[COMMAND_REVIEW_ENV]: String(request.commandReviewMs),
				[RUN_DIR_ENV]: artifacts.dir,
			},
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdoutBuffer = "";
		let spawnError: string | undefined;
		let exitCode: number | null = null;
		let signalCode: NodeJS.Signals | null = null;
		let processExited = false;
		let stdioClosed = false;

		const onStdout = (chunk: Buffer) => {
			stdoutBuffer += chunk.toString("utf8");
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		};
		const onStderr = (chunk: Buffer) => {
			stderrStream.write(chunk);
			if (stderr.length < 20_000) stderr += chunk.toString("utf8").slice(0, 20_000 - stderr.length);
		};
		child.stdout.on("data", onStdout);
		child.stderr.on("data", onStderr);
		child.on("error", (error) => {
			spawnError = error.message;
		});

		const recordExit = (code: number | null, childSignal: NodeJS.Signals | null) => {
			exitCode = code;
			signalCode = childSignal;
		};
		const exitPromise = new Promise<void>((resolve) => {
			child.on("exit", (code, childSignal) => {
				recordExit(code, childSignal);
				processExited = true;
				resolve();
			});
		});
		const closePromise = new Promise<void>((resolve) => {
			child.on("close", (code, childSignal) => {
				recordExit(code, childSignal);
				stdioClosed = true;
				resolve();
			});
		});
		const waitForExit = (waitMs: number): Promise<void> => {
			if (processExited) return Promise.resolve();
			return new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, waitMs);
				void exitPromise.then(() => {
					clearTimeout(timer);
					resolve();
				});
			});
		};

		let resolveAbort!: () => void;
		const abortPromise = new Promise<"abort">((resolve) => {
			resolveAbort = () => resolve("abort");
		});
		const onAbort = () => resolveAbort();
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		const outcome = await Promise.race([closePromise.then(() => "close" as const), abortPromise]);
		aborted = outcome === "abort";

		if (aborted) {
			const signalProcessTree = async (force: boolean): Promise<void> => {
				if (child.pid === undefined) return;
				if (process.platform === "win32") {
					await new Promise<void>((resolve) => {
						execFile(
							"taskkill",
							["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])],
							{ timeout: DEFAULT_TERMINATION_SETTLE_MS, windowsHide: true },
							() => resolve(),
						);
					});
					return;
				}
				try {
					process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
				} catch {
					if (!processExited) child.kill(force ? "SIGKILL" : "SIGTERM");
				}
			};

			const terminationStartedAt = Date.now();
			await signalProcessTree(false);
			await waitForExit(DEFAULT_TERMINATION_GRACE_MS);
			let processTreeAlive = process.platform === "win32" && !processExited;
			if (process.platform !== "win32" && child.pid !== undefined) {
				try {
					process.kill(-child.pid, 0);
					processTreeAlive = true;
				} catch {
					processTreeAlive = false;
				}
			}
			if (processTreeAlive) {
				const remainingGraceMs = Math.max(0, DEFAULT_TERMINATION_GRACE_MS - (Date.now() - terminationStartedAt));
				if (remainingGraceMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, remainingGraceMs));
				await signalProcessTree(true);
			}
			if (!processExited) await waitForExit(DEFAULT_TERMINATION_SETTLE_MS);
			if (!stdioClosed) {
				child.stdout.off("data", onStdout);
				child.stderr.off("data", onStderr);
				child.stdout.destroy();
				child.stderr.destroy();
			}
		}
		signal?.removeEventListener("abort", onAbort);
		if (stdoutBuffer.trim()) processLine(stdoutBuffer);

		const error = aborted
			? `Child ${request.kind} was aborted`
			: spawnError ??
				modelError ??
				(stopReason === "error" || stopReason === "aborted" ? `Child stopped with reason: ${stopReason}` : undefined) ??
				(signalCode ? `Child process ended from ${signalCode}` : undefined) ??
				(exitCode !== null && exitCode !== 0 ? stderr.trim() || `Child exited with code ${exitCode}` : undefined);
		const ok = !error && finalText.length > 0;
		const resolvedError = error ?? (!finalText ? "Child returned no final answer" : undefined);
		meta.status = aborted ? "aborted" : resolvedError ? "failed" : "completed";
		meta.ok = ok;
		meta.exitCode = exitCode;
		if (signalCode) meta.signalCode = signalCode;
		meta.processExited = processExited;
		meta.durationMs = Date.now() - startedAt;
		meta.aborted = aborted;
		if (stopReason !== undefined) meta.stopReason = stopReason;
		if (resolvedError !== undefined) meta.error = resolvedError;
		meta.toolCalls = progress.toolCalls;
		meta.assistantTurns = progress.assistantTurns;
		meta.finishedAt = new Date().toISOString();
		return {
			...baseResult,
			ok,
			text: finalText ? truncateOutput(finalText, request.outputLimitChars) : "",
			exitCode,
			...(signalCode ? { signalCode } : {}),
			durationMs: Date.now() - startedAt,
			aborted,
			stderr: stderr.trim(),
			stopReason,
			error: resolvedError,
			artifacts,
		};
	} catch (error) {
		meta.status = "failed";
		meta.ok = false;
		meta.error = error instanceof Error ? error.message : String(error);
		meta.durationMs = Date.now() - startedAt;
		meta.finishedAt = new Date().toISOString();
		throw error;
	} finally {
		await closeStream(eventsStream);
		await closeStream(stderrStream);
		await writeMeta();
		await rm(join(artifacts.dir, ACTIVE_RUN_FILE), { force: true }).catch(() => {});
	}
}
