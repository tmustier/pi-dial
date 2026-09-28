import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { DEFAULT_MAX_BYTES, getAgentDir, type BashOperations, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createCommandSupervisor,
	createProcessGroupBashOperations,
	prepareSupervisedCommand,
} from "../command-supervisor.ts";

const context = {
	cwd: process.cwd(),
	sessionManager: {
		getSessionId: () => "test-session",
		getSessionFile: () => "/tmp/test-session.jsonl",
	},
	model: { provider: "test-provider", id: "test-model" },
	thinkingLevel: "medium",
} as ExtensionContext;
const resultText = (content: Array<{ type: string; text?: string }>): string =>
	content[0]?.type === "text" ? (content[0].text ?? "") : "";

test("Windows Bash keeps ordinary background jobs attached even when the command exits", { skip: process.platform === "win32" }, () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dial-windows-command-"));
	const evidence = join(dir, "finished");
	const command = prepareSupervisedCommand("sleep 30 & exit 0", "win32");
	assert.match(command, /^trap .* wait; exit .* EXIT\nsleep 30 & exit 0$/);
	assert.equal(prepareSupervisedCommand("echo ok", "darwin"), "echo ok");
	try {
		const result = spawnSync(
			"/bin/bash",
			["-c", prepareSupervisedCommand(`(sleep 0.1; touch ${JSON.stringify(evidence)}) >/dev/null 2>&1 & exit 0`, "win32")],
		);
		assert.equal(result.status, 0);
		assert.equal(existsSync(evidence), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("long commands return control and can be inspected and waited for without restarting", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dial-command-"));
	let finish!: (exitCode: number) => void;
	let executions = 0;
	let executedCommand = "";
	let executedEnvironment: NodeJS.ProcessEnv | undefined;
	const operations: BashOperations = {
		exec: async (command, _cwd, { onData, env }) => {
			executions++;
			executedCommand = command;
			executedEnvironment = env;
			onData(Buffer.from("build started\n"));
			return await new Promise((resolve) => {
				finish = (exitCode) => resolve({ exitCode });
			});
		},
	};

	const oldDialChild = process.env.PI_DIAL_CHILD;
	process.env.PI_DIAL_CHILD = "1";
	try {
		const supervisor = createCommandSupervisor(operations, 20, dir, "export SUPERVISED=1");
		const started = await supervisor.bash.execute("bash-1", { command: "npm test" }, undefined, undefined, context);
		const startedText = started.content[0]?.type === "text" ? started.content[0].text : "";
		const id = startedText.match(/Command (cmd-[0-9a-f]+) is still running/)?.[1];
		assert.ok(id);
		assert.match(startedText, /build started/);

		const inspected = await supervisor.commandSession.execute("session-1", { action: "inspect", id });
		assert.match(resultText(inspected.content), /still running/);
		const listed = await supervisor.commandSession.execute("session-list", { action: "list" });
		assert.match(resultText(listed.content), new RegExp(`${id}\\trunning`));
		const waiting = await supervisor.commandSession.execute("session-wait-1", {
			action: "wait",
			id,
			waitSeconds: 1,
		});
		assert.match(resultText(waiting.content), /still running/);

		setTimeout(() => finish(0), 20);
		const completed = await supervisor.commandSession.execute("session-2", {
			action: "wait",
			id,
			waitSeconds: 1,
		});
		assert.match(resultText(completed.content), /completed successfully/);
		assert.equal(executions, 1);
		assert.match(executedCommand, /^export SUPERVISED=1\nnpm test/);
		assert.equal(executedEnvironment?.PI_SESSION_ID, "test-session");
		assert.equal(executedEnvironment?.PI_SESSION_FILE, "/tmp/test-session.jsonl");
		assert.equal(executedEnvironment?.PI_PROVIDER, "test-provider");
		assert.equal(executedEnvironment?.PI_MODEL, "test-model");
		assert.equal(executedEnvironment?.PI_REASONING_LEVEL, "medium");
		assert.equal(executedEnvironment?.PI_DIAL_CHILD, undefined);
		const pathKey = Object.keys(executedEnvironment ?? {}).find((key) => key.toLowerCase() === "path") ?? "PATH";
		assert.ok(executedEnvironment?.[pathKey]?.split(delimiter).includes(join(getAgentDir(), "bin")));
		assert.equal(readFileSync(join(dir, `${id}.log`), "utf8"), "build started\n");
	} finally {
		if (oldDialChild === undefined) delete process.env.PI_DIAL_CHILD;
		else process.env.PI_DIAL_CHILD = oldDialChild;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the agent can abort a supervised command", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dial-command-"));
	const operations: BashOperations = {
		exec: async (_command, _cwd, { signal }) => {
			await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
			throw new Error("aborted");
		},
	};

	try {
		const supervisor = createCommandSupervisor(operations, 20, dir);
		const started = await supervisor.bash.execute("bash-1", { command: "sleep 300" }, undefined, undefined, context);
		const id = started.content[0]?.type === "text"
			? started.content[0].text.match(/Command (cmd-[0-9a-f]+) is still running/)?.[1]
			: undefined;
		assert.ok(id);

		const aborted = await supervisor.commandSession.execute("session-1", { action: "abort", id });
		assert.match(resultText(aborted.content), /was aborted/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cancelling the initial review wait leaves the supervised command running", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dial-command-"));
	let finish!: () => void;
	let operationSignal: AbortSignal | undefined;
	const operations: BashOperations = {
		exec: async (_command, _cwd, { signal }) => {
			operationSignal = signal;
			return await new Promise((resolve) => {
				finish = () => resolve({ exitCode: 0 });
			});
		},
	};

	try {
		const supervisor = createCommandSupervisor(operations, 1000, dir);
		const cancellation = new AbortController();
		const execution = supervisor.bash.execute("bash-1", { command: "long task" }, cancellation.signal, undefined, context);
		await new Promise((resolve) => setTimeout(resolve, 10));
		cancellation.abort();
		await assert.rejects(execution, /Command wait was cancelled/);
		assert.equal(operationSignal?.aborted, false);
		const listed = resultText((await supervisor.commandSession.execute("list-1", { action: "list" })).content);
		assert.match(listed, /running/);
		const id = listed.match(/cmd-[0-9a-f]+/)?.[0];
		assert.ok(id);
		finish();
		const completed = await supervisor.commandSession.execute("wait-1", { action: "wait", id, waitSeconds: 1 });
		assert.match(resultText(completed.content), /completed successfully/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the display preserves split UTF-8 while the command log preserves exact bytes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dial-command-"));
	const expected = Buffer.from("A😀B\n");
	const operations: BashOperations = {
		exec: async (_command, _cwd, { onData }) => {
			onData(expected.subarray(0, 2));
			onData(expected.subarray(2, 4));
			onData(expected.subarray(4));
			return { exitCode: 0 };
		},
	};

	try {
		const supervisor = createCommandSupervisor(operations, 100, dir);
		const completed = await supervisor.bash.execute("bash-1", { command: "printf output" }, undefined, undefined, context);
		const text = resultText(completed.content);
		assert.match(text, /A😀B/);
		assert.doesNotMatch(text, /�/);
		const id = text.match(/Command (cmd-[0-9a-f]+) completed/)?.[1];
		assert.ok(id);
		assert.deepEqual(readFileSync(join(dir, `${id}.log`)), expected);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("bounded display output does not split UTF-8 at its retained-tail boundary", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dial-command-"));
	const emoji = Buffer.from("😀");
	const chunks = [
		Buffer.alloc(DEFAULT_MAX_BYTES * 2 - 1, 65),
		emoji.subarray(0, 2),
		Buffer.concat([emoji.subarray(2), Buffer.alloc(DEFAULT_MAX_BYTES * 2 - 3, 67)]),
	];
	const operations: BashOperations = {
		exec: async (_command, _cwd, { onData }) => {
			for (const chunk of chunks) onData(chunk);
			return { exitCode: 0 };
		},
	};

	try {
		const supervisor = createCommandSupervisor(operations, 100, dir);
		const completed = await supervisor.bash.execute("bash-1", { command: "large output" }, undefined, undefined, context);
		assert.doesNotMatch(resultText(completed.content), /�/);
		const id = resultText(completed.content).match(/Command (cmd-[0-9a-f]+) completed/)?.[1];
		assert.ok(id);
		assert.deepEqual(readFileSync(join(dir, `${id}.log`)), Buffer.concat(chunks));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test(
	"session shutdown aborts a POSIX background job after its shell exits",
	{ skip: process.platform === "win32" },
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-dial-command-"));
		const pidPath = join(dir, "background.pid");
		let pid: number | undefined;
		try {
			const supervisor = createCommandSupervisor(createProcessGroupBashOperations(), 100, dir);
			const started = await supervisor.bash.execute(
				"bash-1",
				{ command: `sleep 30 & echo $! > ${JSON.stringify(pidPath)}; exit 0` },
				undefined,
				undefined,
				context,
			);
			assert.match(resultText(started.content), /still running/);
			assert.ok(existsSync(pidPath));
			pid = Number(readFileSync(pidPath, "utf8"));
			await supervisor.abortAll();
			assert.throws(() => process.kill(pid!, 0));
		} finally {
			if (pid !== undefined) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

test("the supervisor's bash takes precedence over an installed bash override without a load conflict", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dial-command-owner-"));
	try {
		const probe = join(dir, "bash-owner.json");
		const otherBash = join(dir, "other-bash.ts");
		writeFileSync(
			otherBash,
			`import { writeFileSync } from "node:fs";
export default function (pi) {
	pi.registerTool({ name: "bash", label: "Other", description: "Other bash", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: undefined }) });
	pi.on("session_start", () => writeFileSync(${JSON.stringify(probe)}, JSON.stringify(pi.getAllTools().find((tool) => tool.name === "bash").sourceInfo.path)));
}
`,
		);
		const cli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
		const run = spawnSync(
			process.execPath,
			[cli, "--no-extensions", "-e", join(process.cwd(), "command-supervisor.ts"), "-e", otherBash, "--no-session", "--mode", "json", "--print", "--tools", "bash,command_session", "hi"],
			{ cwd: dir, encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent") }, timeout: 30_000 },
		);
		assert.doesNotMatch(run.stderr, /conflicts with/);
		assert.equal(JSON.parse(readFileSync(probe, "utf8")), join(process.cwd(), "command-supervisor.ts"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test(
	"parent SIGTERM aborts a supervised POSIX process group before the worker exits",
	{ skip: process.platform === "win32" },
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-dial-command-signal-"));
		const pidPath = join(dir, "shell.pid");
		const fixturePath = join(dir, "worker.ts");
		const extensionUrl = pathToFileURL(join(process.cwd(), "command-supervisor.ts")).href;
		writeFileSync(
			fixturePath,
			`import extension from ${JSON.stringify(extensionUrl)};
const tools = new Map();
extension({ registerTool: (tool) => tools.set(tool.name, tool), on: (event, handler) => { if (event === "session_start") handler(); } });
const context = { cwd: process.cwd(), sessionManager: { getSessionId: () => "signal-test", getSessionFile: () => undefined }, thinkingLevel: "off" };
await tools.get("bash").execute("bash-1", { command: ${JSON.stringify(`echo $$ > ${pidPath}; sleep 30`)} }, undefined, undefined, context);
process.stdout.write("READY\\n");
setInterval(() => {}, 1000);
`,
		);
		const child = spawn(process.execPath, [fixturePath], {
			cwd: process.cwd(),
			env: {
				...process.env,
				PI_DIAL_COMMAND_REVIEW_MS: "50",
				PI_DIAL_RUN_DIR: dir,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		try {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("worker did not start its supervised command")), 5000);
				child.once("error", reject);
				child.stdout.on("data", (chunk) => {
					if (!chunk.toString().includes("READY")) return;
					clearTimeout(timer);
					resolve();
				});
			});
			const commandPid = Number(readFileSync(pidPath, "utf8"));
			assert.doesNotThrow(() => process.kill(commandPid, 0));
			child.kill("SIGTERM");
			const exitCode = await new Promise<number | null>((resolve) => child.once("exit", resolve));
			assert.equal(exitCode, 143);
			assert.throws(() => process.kill(commandPid, 0));
		} finally {
			if (child.exitCode === null) child.kill("SIGKILL");
			rmSync(dir, { recursive: true, force: true });
		}
	},
);
