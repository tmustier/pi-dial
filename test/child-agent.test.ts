import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	childPromptCacheKey,
	createRunArtifacts,
	pruneRunArtifacts,
	resolveChildInvocation,
	runChildAgent,
	type ChildRunProgress,
	type ChildRunRequest,
} from "../child-agent.ts";
import cacheAffinityExtension from "../cache-affinity.ts";

function request(script: string, overrides: Partial<ChildRunRequest> = {}): ChildRunRequest {
	return {
		kind: "task",
		mode: "medium",
		model: "test/model",
		thinking: "medium",
		appendSystemPrompt: "Test role instructions",
		input: "Test input",
		cwd: tmpdir(),
		tools: [],
		extensionPaths: [],
		skillPaths: [],
		inheritContext: false,
		inheritSkills: false,
		inheritExtensions: false,
		commandReviewMs: 2_000,
		outputLimitChars: 1_000,
		artifactsBaseDir: join(dirname(script), "runs"),
		provenance: "active-mode",
		commandOverride: { command: process.execPath, prefixArgs: [script] },
		...overrides,
	};
}

test("child invocation uses explicit commands, packaged executables, or pi from PATH", () => {
	const args = ["--mode", "json"];
	assert.deepEqual(resolveChildInvocation(args, { command: "/custom/pi", prefixArgs: ["wrapper"] }, "/usr/bin/node"), {
		command: "/custom/pi",
		args: ["wrapper", ...args],
	});
	assert.deepEqual(resolveChildInvocation(args, undefined, "/Applications/Pi.app/Contents/MacOS/pi"), {
		command: "/Applications/Pi.app/Contents/MacOS/pi",
		args,
	});
	assert.deepEqual(resolveChildInvocation(args, undefined, "/usr/local/bin/node", "/usr/local/bin/pi"), {
		command: "pi",
		args,
	});
	assert.deepEqual(resolveChildInvocation(args, undefined, "/usr/local/bin/bun", "/$bunfs/root/pi"), {
		command: "pi",
		args,
	});
});

test(
	"generic Node hosts launch a shell-based pi command from PATH without parsing it as JavaScript",
	{ skip: process.platform === "win32" },
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-dial-child-"));
		const previousPath = process.env.PATH;
		try {
			const script = join(dir, "fake-pi.mjs");
			const launcher = join(dir, "pi");
			writeFileSync(
				script,
				`process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"shell launcher worked"}],stopReason:"stop"}})+"\\n");`,
			);
			writeFileSync(launcher, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
			chmodSync(launcher, 0o755);
			assert.deepEqual(resolveChildInvocation(["--mode", "json"], undefined, process.execPath, script), {
				command: process.execPath,
				args: [script, "--mode", "json"],
			});
			assert.deepEqual(resolveChildInvocation(["--mode", "json"], undefined, process.execPath, launcher), {
				command: "pi",
				args: ["--mode", "json"],
			});
			process.env.PATH = `${dir}:${previousPath ?? ""}`;

			const result = await runChildAgent(request(script, { commandOverride: undefined }));
			assert.equal(result.ok, true);
			assert.equal(result.text, "shell launcher worked");
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

function readMeta(runDir: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8")) as Record<string, unknown>;
}

test("prompt cache affinity is stable across delegated inputs but changes with the static prefix", () => {
	const base = request("/tmp/fake-pi.mjs");
	assert.equal(childPromptCacheKey(base), childPromptCacheKey({ ...base, input: "different delegated task" }));
	assert.notEqual(childPromptCacheKey(base), childPromptCacheKey({ ...base, appendSystemPrompt: "different role instructions" }));
	assert.notEqual(childPromptCacheKey(base), childPromptCacheKey({ ...base, tools: ["read"] }));
});

test("cache-affinity extension replaces only OpenAI prompt cache keys", () => {
	let handler: ((event: { payload: unknown }, ctx: { model?: { api: string } }) => unknown) | undefined;
	cacheAffinityExtension({
		on(name: string, candidate: typeof handler) {
			if (name === "before_provider_request") handler = candidate;
		},
	} as never);
	assert.ok(handler);
	const previous = process.env.PI_DIAL_PROMPT_CACHE_KEY;
	process.env.PI_DIAL_PROMPT_CACHE_KEY = "pi-dial-task-stable";
	try {
		assert.deepEqual(handler({ payload: { prompt_cache_key: "fresh-session" } }, { model: { api: "openai-codex-responses" } }), {
			prompt_cache_key: "pi-dial-task-stable",
		});
		assert.equal(handler({ payload: { prompt_cache_key: "fresh-session" } }, { model: { api: "anthropic-messages" } }), undefined);
	} finally {
		if (previous === undefined) delete process.env.PI_DIAL_PROMPT_CACHE_KEY;
		else process.env.PI_DIAL_PROMPT_CACHE_KEY = previous;
	}
});
test("child runner extracts the final assistant message from Pi JSON mode", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dial-child-"));
	try {
		const script = join(dir, "fake-pi.mjs");
		writeFileSync(
			script,
			`process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"worker complete"}],stopReason:"stop"}})+"\\n");`,
		);
		const result = await runChildAgent(request(script));
		assert.equal(result.ok, true);
		assert.equal(result.text, "worker complete");
		assert.equal(result.exitCode, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
test("children load installed extensions unless disabled, and mark themselves for Pi Dial", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dial-child-"));
	try {
		const script = join(dir, "fake-pi.mjs");
		writeFileSync(
			script,
			`process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:JSON.stringify({args:process.argv.slice(2),child:process.env.PI_DIAL_CHILD})}],stopReason:"stop"}})+"\\n");`,
		);
		const inherited = JSON.parse((await runChildAgent(request(script, { inheritExtensions: true }))).text);
		assert.ok(!inherited.args.includes("--no-extensions"));
		assert.equal(inherited.child, "1");
		const isolated = JSON.parse((await runChildAgent(request(script, { inheritExtensions: false }))).text);
		assert.ok(isolated.args.includes("--no-extensions"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the command review interval is not a whole-worker deadline", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dial-child-"));
	try {
		const script = join(dir, "delayed-pi.mjs");
		writeFileSync(
			script,
			`if (!process.argv.includes("--no-tools") || process.argv.some((value) => value.includes("command-supervisor"))) process.exit(5);\n` +
				`setTimeout(() => process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"finished after review interval"}],stopReason:"stop"}})+"\\n"), 60);`,
		);
		const result = await runChildAgent(request(script, { commandReviewMs: 10 }));
		assert.equal(result.ok, true);
		assert.equal(result.text, "finished after review interval");
		assert.ok(result.durationMs >= 50);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
test(
	"cancellation kills descendants that ignore SIGTERM and retain the child pipes",
	{ skip: process.platform === "win32" },
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-dial-child-"));
		const pidPath = join(dir, "grandchild.pid");
		const readyPath = join(dir, "grandchild.ready");
		let grandchildPid: number | undefined;
		try {
			const script = join(dir, "process-tree-pi.mjs");
			writeFileSync(
				script,
				`import { spawn } from "node:child_process";\n` +
				`import { writeFileSync } from "node:fs";\n` +
				`const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(`process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, 'ready'); setInterval(()=>{},1000)`)}], { stdio: ["ignore", "inherit", "inherit"] });\n` +
				`writeFileSync(${JSON.stringify(pidPath)}, String(grandchild.pid));\n` +
				`setInterval(() => {}, 1000);`,
			);
			const controller = new AbortController();
			const pending = runChildAgent(request(script), controller.signal);
			for (let attempt = 0; attempt < 100 && (!existsSync(pidPath) || !existsSync(readyPath)); attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.ok(existsSync(readyPath));
			controller.abort();
			const result = await pending;
			assert.equal(result.aborted, true);
			grandchildPid = Number(readFileSync(pidPath, "utf8"));
			assert.ok(Number.isSafeInteger(grandchildPid));
			let alive = true;
			for (let attempt = 0; attempt < 20 && alive; attempt++) {
				try {
					process.kill(grandchildPid, 0);
					await new Promise((resolve) => setTimeout(resolve, 10));
				} catch {
					alive = false;
				}
			}
			assert.equal(alive, false, "the forced process-group kill must terminate the grandchild");
		} finally {
			if (grandchildPid !== undefined) {
				try {
					process.kill(grandchildPid, "SIGKILL");
				} catch {}
			}
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

test("successful runs persist input, session flag, events, stderr, and meta artifacts", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dial-child-"));
	try {
		const script = join(dir, "fake-pi.mjs");
		// Echo argv to stderr so the persisted stderr.log proves which flags the child received.
		writeFileSync(
			script,
			`process.stderr.write(JSON.stringify({args:process.argv.slice(2),cacheKey:process.env.PI_DIAL_PROMPT_CACHE_KEY,commandReviewMs:process.env.PI_DIAL_COMMAND_REVIEW_MS,runDir:process.env.PI_DIAL_RUN_DIR}));\n` +
				`process.stdout.write(JSON.stringify({type:"tool_execution_start",toolCallId:"t1",toolName:"bash",args:{}})+"\\n");\n` +
				`process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"worker complete"}],stopReason:"stop"}})+"\\n");`,
		);
		const progressUpdates: ChildRunProgress[] = [];
		const configuredExtension = join(dir, "configured-extension.ts");
		const result = await runChildAgent(
			request(script, {
				input: "forensic input body",
				tools: ["bash"],
				extensionPaths: [configuredExtension],
				commandReviewMs: 12_345,
				onProgress: (progress) => progressUpdates.push(progress),
			}),
		);
		assert.equal(result.ok, true);
		assert.ok(result.artifacts);
		const runDir = result.artifacts.dir;
		assert.equal(readFileSync(join(runDir, "input.md"), "utf8"), "forensic input body");
		const stderrLog = readFileSync(join(runDir, "stderr.log"), "utf8");
		assert.ok(stderrLog.includes("--session"), "child must run with --session");
		assert.ok(stderrLog.includes(join(runDir, "session.jsonl")), "session must persist inside the run dir");
		assert.ok(!stderrLog.includes("--no-session"), "child must not run ephemeral");
		assert.ok(stderrLog.includes("cache-affinity.ts"), "child must load the cache-affinity extension");
		assert.ok(stderrLog.includes("command-supervisor.ts"), "bash-enabled children must load command supervision");
		assert.ok(stderrLog.includes("bash,command_session"), "children must be able to manage running commands");
		assert.ok(stderrLog.includes("12345"), "child must receive its command review interval");
		assert.ok(
			stderrLog.indexOf("command-supervisor.ts") < stderrLog.indexOf(configuredExtension),
			"command supervision must own bash before configured extensions register tools",
		);
		assert.match(stderrLog, /pi-dial-task-[0-9a-f]{32}/, "child must receive a stable prompt cache key");
		const events = readFileSync(join(runDir, "events.jsonl"), "utf8").trim().split("\n");
		assert.equal(events.length, 2);
		assert.match(events[0], /tool_execution_start/);
		const meta = readMeta(runDir);
		assert.equal(meta.status, "completed");
		assert.equal(meta.ok, true);
		assert.equal(meta.provenance, "active-mode");
		assert.match(String(meta.promptCacheKey), /^pi-dial-task-[0-9a-f]{32}$/);
		assert.equal(meta.toolCalls, 1);
		assert.equal(meta.assistantTurns, 1);
		assert.equal(meta.commandReviewMs, 12_345);
		assert.equal(meta.stopReason, "stop");
		assert.equal(existsSync(join(runDir, ".active.json")), false);
		const last = progressUpdates.at(-1);
		assert.equal(last?.toolCalls, 1);
		assert.equal(last?.lastTool, "bash");
		assert.equal(last?.artifactsDir, runDir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("unspawnable runs leave forensic artifacts behind", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dial-child-"));
	try {
		const script = join(dir, "slow-pi.mjs");
		writeFileSync(script, "");

		const unspawnable = await runChildAgent(
			request(script, {
				commandOverride: { command: join(dir, "missing-binary") },
			}),
		);
		assert.equal(unspawnable.ok, false);
		assert.ok(unspawnable.artifacts);
		const spawnMeta = readMeta(unspawnable.artifacts.dir);
		assert.equal(spawnMeta.status, "failed");
		assert.match(String(spawnMeta.error ?? ""), /ENOENT|missing-binary/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("run retention prunes by age and count but never touches fresh or foreign directories", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dial-child-"));
	try {
		const base = join(dir, "runs");
		mkdirSync(base, { recursive: true });
		const now = Date.now();
		const makeRun = (name: string, ageMs: number): string => {
			const runDir = join(base, name);
			mkdirSync(runDir);
			writeFileSync(join(runDir, "meta.json"), "{}");
			const seconds = (now - ageMs) / 1000;
			utimesSync(runDir, seconds, seconds);
			return name;
		};
		const ancient = makeRun("2026-01-01T00-00-00-000Z-task-aaaaaa", 20 * 24 * 60 * 60 * 1000);
		const oldOverflow = makeRun("2026-07-01T00-00-00-000Z-task-bbbbbb", 3 * 60 * 60 * 1000);
		const keptRecent = makeRun("2026-07-20T00-00-00-000Z-oracle-cccccc", 2 * 60 * 60 * 1000);
		const inFlight = makeRun("2026-07-29T00-00-00-000Z-task-dddddd", 1000);
		const longRunning = makeRun("2026-07-15T00-00-00-000Z-task-eeeeee", 20 * 24 * 60 * 60 * 1000);
		writeFileSync(join(base, longRunning, ".active.json"), JSON.stringify({ pid: process.pid }));
		const longRunningSeconds = (now - 20 * 24 * 60 * 60 * 1000) / 1000;
		utimesSync(join(base, longRunning), longRunningSeconds, longRunningSeconds);
		const foreign = join(base, "unrelated-directory");
		mkdirSync(foreign);
		utimesSync(foreign, (now - 30 * 24 * 60 * 60 * 1000) / 1000, (now - 30 * 24 * 60 * 60 * 1000) / 1000);

		const removed = await pruneRunArtifacts(
			base,
			{ maxRuns: 2, maxAgeMs: 14 * 24 * 60 * 60 * 1000, minAgeMs: 60 * 60 * 1000 },
			now,
		);
		assert.deepEqual(removed.sort(), [ancient, oldOverflow].sort());
		const remaining = readdirSync(base).sort();
		// inFlight is younger than minAgeMs and longRunning has a live owner marker;
		// keptRecent fills the second kept slot; oldOverflow exceeds maxRuns; ancient exceeds
		// maxAgeMs; foreign names are never considered.
		assert.deepEqual(remaining, [keptRecent, inFlight, longRunning, "unrelated-directory"].sort());
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("createRunArtifacts produces prunable, sortable run directory names", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dial-child-"));
	try {
		const artifacts = await createRunArtifacts(join(dir, "runs"), "oracle");
		const name = artifacts.dir.split("/").at(-1) ?? "";
		assert.match(name, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-oracle-[0-9a-f]{6}$/);
		const removed = await pruneRunArtifacts(
			join(dir, "runs"),
			{ maxRuns: 0, maxAgeMs: 0, minAgeMs: 0 },
			Date.now() + 1000,
		);
		assert.deepEqual(removed, [name]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("child runner propagates cancellation", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dial-child-"));
	try {
		const script = join(dir, "slow-pi.mjs");
		writeFileSync(script, `setTimeout(() => {}, 10_000);`);
		const controller = new AbortController();
		const pending = runChildAgent(request(script), controller.signal);
		setTimeout(() => controller.abort(), 30);
		const result = await pending;
		assert.equal(result.ok, false);
		assert.equal(result.aborted, true);
		assert.match(result.error ?? "", /aborted/);
		assert.ok(result.artifacts);
		assert.ok(existsSync(result.artifacts.inputPath));
		assert.equal(readMeta(result.artifacts.dir).status, "aborted");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
