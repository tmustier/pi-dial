import type { WorkerHandle } from "../collaboration-coordinator.ts";

export const idleWorker: WorkerHandle = {
	startTask() {},
	deliver() {},
	interrupt() {},
	dispose() {},
};

export const coordinatorDefaults = {
	maxActive: 4,
	maxDepth: 3,
	maxAgents: 32,
	getHistory: () => [],
	notifyRoot() {},
	createWorker: () => idleWorker,
};
