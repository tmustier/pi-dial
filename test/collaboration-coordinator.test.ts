import assert from "node:assert/strict";
import test from "node:test";
import { CollaborationCoordinator, type SpawnContext } from "../collaboration-coordinator.ts";
import type { NativeAgentMessageRecord } from "../collaboration-wire.ts";
import { coordinatorDefaults, idleWorker } from "./collaboration-fixtures.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function harness() {
	const starts = new Map<string, NativeAgentMessageRecord[][]>();
	const deliveries = new Map<string, NativeAgentMessageRecord[][]>();
	const interrupted: string[] = [];
	const coordinator = new CollaborationCoordinator({
		...coordinatorDefaults,
		createWorker({ name }) {
			starts.set(name, []);
			deliveries.set(name, []);
			const receive = () => {
				const records = coordinator.drainMailbox(name);
				for (const record of records) coordinator.acknowledgeDelivery(name, record);
				return records;
			};
			return {
				...idleWorker,
				startTask() { starts.get(name)!.push(receive()); },
				deliver() { deliveries.get(name)!.push(receive()); },
				interrupt() { interrupted.push(name); },
			};
		},
	});
	return { coordinator, starts, deliveries, interrupted };
}

test("spawn reserves capacity before initialization, validates model input and selects recent turns", async () => {
	let release!: () => void;
	const contexts: SpawnContext<string>[] = [];
	const coordinator = new CollaborationCoordinator<string>({
		...coordinatorDefaults, maxActive: 1, maxDepth: 1, getHistory: () => ["a", "b", "c"],
		async createWorker(context) {
			contexts.push(context);
			await new Promise<void>(resolve => { release = resolve; });
			return idleWorker;
		},
	});
	assert.deepEqual(coordinator.spawnAgent("/root", { task_name: "review_2", message: "go", encrypted: false, fork_turns: "2" }), { task_name: "/root/review_2" });
	assert.throws(() => coordinator.spawnAgent("/root", { task_name: "other", message: "go", encrypted: false }), /Maximum active/);
	assert.throws(() => coordinator.spawnAgent("/root", { task_name: "Bad-name", message: "go", encrypted: false }), /task_name/);
	assert.throws(() => coordinator.sendMessage("/root", "/elsewhere", "x"), /Invalid agent path/);
	await tick();
	assert.deepEqual(contexts[0].history, ["b", "c"]);
	assert.throws(() => coordinator.spawnAgent("/root/review_2", { task_name: "deep", message: "x", encrypted: false }), /depth/);
	release();
	await coordinator.dispose();
});

test("idle mail waits for a follow-up; an active follow-up delivers without starting another turn", async () => {
	const { coordinator, starts, deliveries } = harness();
	coordinator.spawnAgent("/root", { task_name: "worker", message: "initial", encrypted: false });
	await tick();
	coordinator.complete("/root/worker", "first done", 0);
	assert.deepEqual(coordinator.drainMailbox("/root")[0], {
		type: "agent_message", author: "/root/worker", recipient: "/root",
		content: [{ type: "input_text", text: "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/worker\nPayload:\nfirst done" }],
	});
	coordinator.sendMessage("/root", "worker", "queued one");
	coordinator.sendMessage("/root", "worker", "opaque", true);
	assert.equal(deliveries.get("/root/worker")!.length, 0);
	coordinator.followupTask("/root", "worker", "next task");
	const mail = starts.get("/root/worker")!.at(-1)!;
	assert.deepEqual(mail.map(record => (record.content[0] as { text: string }).text.split("\n").at(-1)), ["queued one", "", "next task"]);
	assert.deepEqual(mail[1].content[1], { type: "encrypted_content", encrypted_content: "opaque" });
	coordinator.followupTask("/root", "worker", "again");
	assert.equal(starts.get("/root/worker")!.length, 2);
	assert.match((deliveries.get("/root/worker")![0][0].content[0] as { text: string }).text, /^Message Type: NEW_TASK/);
	await coordinator.dispose();
});

test("interrupt returns prior status, affects only the target, and emits no false final", async () => {
	const { coordinator, interrupted } = harness();
	coordinator.spawnAgent("/root", { task_name: "parent", message: "go", encrypted: false }); await tick();
	coordinator.spawnAgent("/root/parent", { task_name: "child", message: "go", encrypted: false }); await tick();
	assert.deepEqual(coordinator.interruptAgent("/root", "parent"), { previous_status: "running" });
	assert.deepEqual(interrupted, ["/root/parent"]);
	assert.deepEqual(coordinator.listAgents("/root/parent").agents.map(agent => agent.agent_status), ["interrupted", "running"]);
	assert.deepEqual(coordinator.drainMailbox("/root"), []);
	assert.throws(() => coordinator.interruptAgent("/root", "/root"), /root or self/);
	await coordinator.dispose();
});
