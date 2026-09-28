import { spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { randomBytes } from "node:crypto";
import { finished } from "node:stream/promises";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
	createBashToolDefinition,
	createLocalBashOperations,
	DEFAULT_MAX_BYTES,
	getAgentDir,
	getShellConfig,
	SettingsManager,
	truncateTail,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type BashOperations,
	type BashToolDetails,
	type BashToolInput,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_COMMAND_REVIEW_MS, MAX_COMMAND_REVIEW_MS } from "./config.ts";

export const COMMAND_SESSION_TOOL = "command_session";

type CommandStatus = "running" | "completed" | "failed" | "aborted" | "timed-out";
type CommandSessionInput = {
	action: "list" | "inspect" | "wait" | "abort";
	id?: string;
	waitSeconds?: number;
};

interface CommandRecord {
	id: string;
	command: string;
	startedAt: number;
	finishedAt?: number;
	status: CommandStatus;
	exitCode: number | null;
	error?: string;
	controller: AbortController;
	completion: Promise<void>;
	decoder: TextDecoder;
	output: string;
	outputBytes: number;
	totalOutputBytes: number;
	logPath: string;
	log: WriteStream;
}

const commandSessionSchema = Type.Object({
	action: StringEnum(["list", "inspect", "wait", "abort"] as const, {
		description: "List commands, inspect one, wait for one, or abort one",
	}),
	id: Type.Optional(Type.String({ description: "Command ID returned by bash; required except for list" })),
	waitSeconds: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 3600,
			description: "For wait, how many seconds to wait before returning control again",
		}),
	),
});

function shellEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const binDir = join(getAgentDir(), "bin");
	const currentPath = env[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	return {
		...env,
		[pathKey]: pathEntries.includes(binDir) ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter),
	};
}

export function createProcessGroupBashOperations(shellPath?: string): BashOperations {
	const shell = getShellConfig(shellPath);
	return {
		async exec(command, cwd, { onData, signal, timeout, env }) {
			if (signal?.aborted) throw new Error("aborted");
			if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > 2_147_483_647)) {
				throw new Error("Invalid timeout: expected positive seconds within the Node timer limit");
			}
			await access(cwd);
			const fromStdin = shell.commandTransport === "stdin";
			const child = spawn(shell.shell, fromStdin ? shell.args : [...shell.args, command], {
				cwd,
				detached: true,
				env: shellEnvironment(env ?? process.env),
				stdio: [fromStdin ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			if (fromStdin) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(command);
			}
			child.stdout?.on("data", onData);
			child.stderr?.on("data", onData);
			let timedOut = false;
			const killGroup = () => {
				if (child.pid === undefined) return;
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					try {
						process.kill(child.pid, "SIGKILL");
					} catch {}
				}
			};
			const onAbort = () => killGroup();
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
			const timeoutHandle = timeout === undefined
				? undefined
				: setTimeout(() => {
						timedOut = true;
						killGroup();
					}, timeout * 1000);
			const closePromise = new Promise<void>((resolve) => child.once("close", () => resolve()));
			try {
				const exitCode = await new Promise<number | null>((resolve, reject) => {
					child.once("error", reject);
					child.once("exit", (code) => resolve(code));
				});
				if (child.pid !== undefined) {
					while (true) {
						try {
							process.kill(-child.pid, 0);
							await new Promise<void>((resolve) => setTimeout(resolve, 50));
						} catch {
							break;
						}
					}
				}
				await Promise.race([closePromise, new Promise<void>((resolve) => setTimeout(resolve, 100))]);
				if (signal?.aborted) throw new Error("aborted");
				if (timedOut) throw new Error(`timeout:${timeout}`);
				return { exitCode };
			} finally {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				signal?.removeEventListener("abort", onAbort);
				child.stdout?.destroy();
				child.stderr?.destroy();
			}
		},
	};
}

function cleanOutput(text: string): string {
	return text
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return remainder === 0 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : `${minutes}m ${remainder}s`;
}

export function prepareSupervisedCommand(command: string, platform = process.platform): string {
	if (platform !== "win32") return command;
	return `trap '__pi_dial_status=$?; trap - EXIT; wait; exit "$__pi_dial_status"' EXIT\n${command}`;
}

export function createCommandSupervisor(
	operations: BashOperations,
	reviewMs: number,
	logDir: string,
	commandPrefix?: string,
) {
	const commands = new Map<string, CommandRecord>();
	const bash = createBashToolDefinition(process.cwd());

	const appendDisplayOutput = (record: CommandRecord, text: string): void => {
		if (!text) return;
		record.output += text;
		const addedBytes = Buffer.byteLength(text);
		record.outputBytes += addedBytes;
		record.totalOutputBytes += addedBytes;
		if (record.outputBytes <= DEFAULT_MAX_BYTES * 2) return;
		const buffer = Buffer.from(record.output);
		let start = buffer.length - DEFAULT_MAX_BYTES * 2;
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
		record.output = buffer.subarray(start).toString("utf8");
		record.outputBytes = Buffer.byteLength(record.output);
	};

	const appendOutput = (record: CommandRecord, chunk: Buffer): void => {
		record.log.write(chunk);
		appendDisplayOutput(record, record.decoder.decode(chunk, { stream: true }));
	};

	const snapshot = (record: CommandRecord): string => {
		const tail = cleanOutput(record.output);
		const truncated = truncateTail(tail);
		let output = truncated.content.trimEnd();
		if (record.totalOutputBytes > record.outputBytes || truncated.truncated) {
			output += `${output ? "\n\n" : ""}[Output truncated. Full output: ${record.logPath}]`;
		}
		return output;
	};

	const formatRecord = (record: CommandRecord): string => {
		const elapsed = formatDuration((record.finishedAt ?? Date.now()) - record.startedAt);
		const output = snapshot(record);
		const status =
			record.status === "running"
				? `Command ${record.id} is still running after ${elapsed}.`
				: record.status === "completed"
					? `Command ${record.id} completed successfully after ${elapsed}.`
					: record.status === "aborted"
						? `Command ${record.id} was aborted after ${elapsed}.`
						: record.status === "timed-out"
							? `Command ${record.id} reached its explicit timeout after ${elapsed}.`
							: `Command ${record.id} failed after ${elapsed}${record.exitCode === null ? "" : ` with exit code ${record.exitCode}`}.`;
		const next =
			record.status === "running"
				? `Use ${COMMAND_SESSION_TOOL} to inspect it, wait for it again, or abort it.`
				: `Full output: ${record.logPath}`;
		return [output, status, record.error, next].filter(Boolean).join("\n\n");
	};

	const waitFor = async (record: CommandRecord, waitMs: number, signal?: AbortSignal): Promise<void> => {
		if (record.status !== "running") return;
		if (signal?.aborted) throw new Error("Command wait was cancelled");
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(finish, waitMs);
			const onAbort = () => finish(new Error("Command wait was cancelled"));
			function finish(error?: Error): void {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				if (error) reject(error);
				else resolve();
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			void record.completion.then(() => finish());
		});
	};

	const requireCommand = (id: string | undefined): CommandRecord => {
		if (!id) throw new Error("command_session requires id for inspect, wait, and abort");
		const record = commands.get(id);
		if (!record) throw new Error(`Unknown command ID: ${id}`);
		return record;
	};

	const abortAll = async (): Promise<void> => {
		const running = [...commands.values()].filter((record) => record.status === "running");
		for (const record of running) record.controller.abort();
		await Promise.all(running.map((record) => record.completion));
	};

	return {
		bash: {
			...bash,
			description:
				`${bash.description} Commands that outlast the configured review interval keep running and return a command ID for later inspection.`,
			promptGuidelines: [
				...(bash.promptGuidelines ?? []),
				"When bash returns a running command ID, use command_session to inspect it, wait again, or abort it before finishing the task.",
			],
			async execute(
				_toolCallId: string,
				{ command, timeout }: BashToolInput,
				signal: AbortSignal | undefined,
				onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
				ctx: ExtensionContext,
			): Promise<AgentToolResult<BashToolDetails | undefined>> {
				if (signal?.aborted) throw new Error("Command wait was cancelled");
				await mkdir(logDir, { recursive: true, mode: 0o700 });
				const id = `cmd-${randomBytes(3).toString("hex")}`;
				const logPath = join(logDir, `${id}.log`);
				const log = createWriteStream(logPath, { flags: "a", mode: 0o600 });
				const controller = new AbortController();
				const record: CommandRecord = {
					id,
					command,
					startedAt: Date.now(),
					status: "running",
					exitCode: null,
					controller,
					completion: Promise.resolve(),
					decoder: new TextDecoder(),
					output: "",
					outputBytes: 0,
					totalOutputBytes: 0,
					logPath,
					log,
				};
				commands.set(id, record);
				log.on("error", (error) => {
					record.error ??= `Could not write command log: ${error.message}`;
				});

				let updateTimer: NodeJS.Timeout | undefined;
				const emitUpdate = () => {
					updateTimer = undefined;
					onUpdate?.({ content: [{ type: "text", text: snapshot(record) }], details: undefined });
				};
				const onData = (data: Buffer) => {
					appendOutput(record, data);
					updateTimer ??= setTimeout(emitUpdate, 250);
				};

				const shellCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
				const supervisedCommand = prepareSupervisedCommand(shellCommand);
				const env = shellEnvironment(process.env);
				delete env.PI_SESSION_ID;
				delete env.PI_SESSION_FILE;
				delete env.PI_PROVIDER;
				delete env.PI_MODEL;
				delete env.PI_REASONING_LEVEL;
				env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
				const sessionFile = ctx.sessionManager.getSessionFile();
				if (sessionFile) env.PI_SESSION_FILE = sessionFile;
				if (ctx.model) {
					env.PI_PROVIDER = ctx.model.provider;
					env.PI_MODEL = ctx.model.id;
				}
				if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;

				record.completion = operations
					.exec(supervisedCommand, ctx.cwd, { onData, signal: controller.signal, timeout, env })
					.then(({ exitCode }) => {
						record.exitCode = exitCode;
						record.finishedAt = Date.now();
						record.status = exitCode === 0 ? "completed" : "failed";
					})
					.catch((error: unknown) => {
						const message = error instanceof Error ? error.message : String(error);
						record.finishedAt = Date.now();
						if (controller.signal.aborted) record.status = "aborted";
						else if (message.startsWith("timeout:")) record.status = "timed-out";
						else {
							record.status = "failed";
							record.error = message;
						}
					})
					.finally(async () => {
						if (updateTimer) clearTimeout(updateTimer);
						appendDisplayOutput(record, record.decoder.decode());
						record.log.end();
						await finished(record.log).catch(() => {});
					});

				await waitFor(record, reviewMs, signal);
				const result = formatRecord(record);
				if (record.status === "failed" || record.status === "timed-out") throw new Error(result);
				return { content: [{ type: "text" as const, text: result }], details: undefined };
			},
		},
		commandSession: {
			name: COMMAND_SESSION_TOOL,
			label: "Command session",
			description:
				"List supervised bash commands, inspect current output, wait for a chosen interval, or abort a running command. Output is limited to the last 2,000 lines or 50KB and links to the complete log.",
			promptSnippet: "Inspect, wait for, or abort long-running bash commands",
			promptGuidelines: [
				"Use command_session when bash returns a running command ID. Inspect evidence, then choose to wait again or abort the command.",
			],
			parameters: commandSessionSchema,
			async execute(
				_toolCallId: string,
				{ action, id, waitSeconds }: CommandSessionInput,
				signal?: AbortSignal,
			): Promise<AgentToolResult<undefined>> {
				if (action === "list") {
					if (commands.size === 0) {
						return { content: [{ type: "text", text: "No supervised commands." }], details: undefined };
					}
					const rows = [...commands.values()].map(
						(record) =>
							`${record.id}\t${record.status}\t${formatDuration((record.finishedAt ?? Date.now()) - record.startedAt)}\t${record.command.replace(/\s+/g, " ").slice(0, 160)}`,
					);
					return { content: [{ type: "text", text: rows.join("\n") }], details: undefined };
				}
				const record = requireCommand(id);
				if (action === "wait") {
					const seconds = waitSeconds ?? Math.min(3600, Math.ceil(reviewMs / 1000));
					await waitFor(record, seconds * 1000, signal);
				}
				if (action === "abort" && record.status === "running") {
					record.controller.abort();
					await record.completion;
				}
				const result = formatRecord(record);
				if (record.status === "failed" || record.status === "timed-out") throw new Error(result);
				return { content: [{ type: "text", text: result }], details: undefined };
			},
		},
		abortAll,
	};
}

export default function commandSupervisorExtension(pi: ExtensionAPI): void {
	const configuredReviewMs = Number(process.env.PI_DIAL_COMMAND_REVIEW_MS);
	const reviewMs = Number.isSafeInteger(configuredReviewMs) && configuredReviewMs > 0 && configuredReviewMs <= MAX_COMMAND_REVIEW_MS
		? configuredReviewMs
		: DEFAULT_COMMAND_REVIEW_MS;
	const logDir = process.env.PI_DIAL_RUN_DIR || join(tmpdir(), "pi-dial-commands");
	const settings = SettingsManager.create(process.cwd(), getAgentDir());
	const operations = process.platform === "win32"
		? createLocalBashOperations({ shellPath: settings.getShellPath() })
		: createProcessGroupBashOperations(settings.getShellPath());
	const supervisor = createCommandSupervisor(
		operations,
		reviewMs,
		logDir,
		settings.getShellCommandPrefix(),
	);
	pi.registerTool(supervisor.bash);
	pi.registerTool(supervisor.commandSession);
	let terminating = false;
	const onTerminationSignal = (): void => {
		if (terminating) return;
		terminating = true;
		void supervisor.abortAll().finally(() => process.exit(143));
	};
	if (process.env.PI_DIAL_RUN_DIR) {
		process.once("SIGTERM", onTerminationSignal);
	}
	pi.on("session_shutdown", async () => {
		process.removeListener("SIGTERM", onTerminationSignal);
		await supervisor.abortAll();
	});
}
