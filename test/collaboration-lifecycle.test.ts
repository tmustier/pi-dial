import assert from "node:assert/strict";
import test from "node:test";
import { CollaborationCoordinator } from "../collaboration-coordinator.ts";
import { coordinatorDefaults, idleWorker } from "./collaboration-fixtures.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("wait does not return for spare capacity and tracks steering until actual model delivery", async () => {
	const coordinator = new CollaborationCoordinator(coordinatorDefaults);
	let settled = false;
	const waiting = coordinator.waitAgent("/root").then(result => { settled = true; return result; });
	await tick();
	assert.equal(settled, false, "Free worker slots are not Codex mailbox activity");
	coordinator.sendMessage("/root", "/root", "hello");
	const [record] = coordinator.drainMailbox("/root");
	assert.equal((await waiting).timed_out, false);
	assert.equal((await coordinator.waitAgent("/root")).timed_out, false, "Queued steering is still pending input");
	coordinator.acknowledgeDelivery("/root", record);
	const abort = new AbortController();
	const afterAck = coordinator.waitAgent("/root", undefined, abort.signal);
	abort.abort();
	await assert.rejects(afterAck, /aborted/);
	await coordinator.dispose();
});

test("wait clamps timeout with Codex's exact result, handles user steering, and validates maximum", async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const coordinator = new CollaborationCoordinator(coordinatorDefaults);
	const pending = coordinator.waitAgent("/root", 1);
	t.mock.timers.tick(10_000);
	assert.deepEqual(await pending, { message: "Wait timed out.\n\nRequested timeout of 1ms was clamped to the minimum of 10000ms.", timed_out: true });
	const steered = coordinator.waitAgent("/root");
	coordinator.steer("/root");
	assert.deepEqual(await steered, { message: "Wait interrupted by new input.", timed_out: false });
	await assert.rejects(coordinator.waitAgent("/root", 3_600_001), /must be at most 3600000/);
	await assert.rejects(coordinator.waitAgent("/root", 1.5), /integer/);
	await coordinator.dispose();
});

test("follow-up respects capacity; stale pre-interrupt completion cannot complete a replacement turn", async () => {
	const generations: number[] = [];
	const coordinator = new CollaborationCoordinator({ ...coordinatorDefaults, maxActive: 1,
		createWorker: () => ({ ...idleWorker, startTask(generation) { generations.push(generation); } }),
	});
	coordinator.spawnAgent("/root", { task_name: "one", message: "start", encrypted: false }); await tick();
	coordinator.complete("/root/one", "first", generations[0]);
	coordinator.spawnAgent("/root", { task_name: "two", message: "start", encrypted: false }); await tick();
	assert.throws(() => coordinator.followupTask("/root", "one", "next"), /Maximum active/);
	coordinator.interruptAgent("/root", "two");
	coordinator.followupTask("/root", "two", "replacement");
	coordinator.complete("/root/two", "stale", generations[1]);
	assert.equal(coordinator.listAgents("/root/two").agents[0].agent_status, "running");
	coordinator.complete("/root/two", "fresh", generations[2]);
	assert.deepEqual(coordinator.interruptAgent("/root", "two").previous_status, { completed: "fresh" });
	assert.deepEqual(coordinator.listAgents("/root/two").agents[0].agent_status, { completed: "fresh" }, "Interrupting an idle agent is a no-op");
	await coordinator.dispose();
});

test("dispose waits for in-flight initialization and aborts outstanding waits", async () => {
	let release!: () => void;
	let disposed = 0;
	let starts = 0;
	const coordinator = new CollaborationCoordinator({ ...coordinatorDefaults,
		async createWorker() { await new Promise<void>(resolve => { release = resolve; }); return { ...idleWorker, startTask() { starts++; }, dispose() { disposed++; } }; },
	});
	coordinator.spawnAgent("/root", { task_name: "pending", message: "start", encrypted: false }); await tick();
	const waiting = assert.rejects(coordinator.waitAgent("/root"), /aborted/);
	let closed = false;
	const shutdown = coordinator.dispose().then(() => { closed = true; });
	await tick();
	assert.equal(closed, false);
	release(); await shutdown; await waiting;
	assert.equal(starts, 0); assert.equal(disposed, 1);
	assert.throws(() => coordinator.sendMessage("/root", "/root", "late"), /disposed/);
});

test("failure reports a terminal envelope to the direct parent without silently swallowing errors", async () => {
	const coordinator = new CollaborationCoordinator({ ...coordinatorDefaults, createWorker() { throw new Error("worker initialization failed"); } });
	coordinator.spawnAgent("/root", { task_name: "broken", message: "start", encrypted: false }); await tick();
	assert.deepEqual(coordinator.listAgents("/root/broken").agents[0].agent_status, { errored: "worker initialization failed" });
	const [record] = coordinator.drainMailbox("/root");
	assert.equal(record.author, "/root/broken");
	assert.match((record.content[0] as { text: string }).text, /^Message Type: FINAL_ANSWER.*Agent errored: worker initialization failed/s);
	await coordinator.dispose();
});

test("fork counts reject zero, accept Codex case/whitespace normalization, and bound retained workers", async () => {
	const histories: unknown[] = [];
	const coordinator = new CollaborationCoordinator({ ...coordinatorDefaults, maxAgents: 1, getHistory: () => ["a", "b"],
		createWorker(context) { histories.push(context.history); return idleWorker; },
	});
	assert.throws(() => coordinator.spawnAgent("/root", { task_name: "zero", message: "go", encrypted: false, fork_turns: "0" }), /positive integer/);
	coordinator.spawnAgent("/root", { task_name: "one", message: "go", encrypted: false, fork_turns: " NONE " }); await tick();
	assert.deepEqual(histories, [[]]);
	coordinator.complete("/root/one", "done", 0);
	assert.throws(() => coordinator.spawnAgent("/root", { task_name: "two", message: "go", encrypted: false }), /retained agents/);
	await coordinator.dispose();
});
