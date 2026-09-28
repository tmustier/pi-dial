import type { NativeAgentMessageRecord } from "./collaboration-wire.ts";

export type AgentStatus = "pending_init" | "running" | "interrupted" | "shutdown" | "not_found"
	| { completed: string | null } | { errored: string };
type MessageType = "NEW_TASK" | "MESSAGE" | "FINAL_ANSWER";
export interface WorkerHandle {
	deliver(): void | Promise<void>;
	startTask(generation: number): void | Promise<void>;
	interrupt(): void | Promise<void>;
	dispose(): void | Promise<void>;
}
export interface SpawnContext<TTurn> {
	name: string;
	parent: string;
	history: readonly TTurn[];
}
export interface CollaborationCoordinatorOptions<TTurn> {
	maxActive: number;
	maxDepth: number;
	maxAgents: number;
	createWorker(context: SpawnContext<TTurn>): WorkerHandle | Promise<WorkerHandle>;
	getHistory(agent: string): readonly TTurn[];
	notifyRoot(): void | Promise<void>;
}
interface Agent {
	name: string;
	parent?: string;
	status: AgentStatus;
	active: boolean;
	mailbox: NativeAgentMessageRecord[];
	delivered: Set<NativeAgentMessageRecord>;
	handle?: WorkerHandle;
	generation: number;
	waiters: Set<(reason: "mail" | "steer" | "abort") => void>;
}
export interface SpawnAgentArguments {
	task_name: string;
	message: string;
	fork_turns?: string;
	encrypted: boolean;
}

export class CollaborationCoordinator<TTurn = unknown> {
	private readonly agents = new Map<string, Agent>();
	private disposed = false;
	private readonly initializing = new Set<Promise<void>>();
	private readonly options: CollaborationCoordinatorOptions<TTurn>;

	constructor(options: CollaborationCoordinatorOptions<TTurn>) {
		this.options = options;
		this.agents.set("/root", { name: "/root", status: { completed: null }, active: false,
			mailbox: [], delivered: new Set(), generation: 0, waiters: new Set() });
	}

	spawnAgent(caller: string, args: SpawnAgentArguments): { task_name: string } {
		const parent = this.agent(caller);
		if (!/^[a-z0-9_]+$/.test(args.task_name)) throw new Error("task_name must contain only lowercase letters, digits, and underscores");
		const name = `${parent.name}/${args.task_name}`;
		if (this.agents.has(name)) throw new Error(`Agent already exists: ${name}`);
		if (name.split("/").length - 2 > this.options.maxDepth) throw new Error(`Maximum agent depth (${this.options.maxDepth}) reached`);
		if (this.agents.size - 1 >= this.options.maxAgents) throw new Error("Maximum retained agents reached");
		this.reserveCapacity();

		const fork = args.fork_turns?.trim().toLowerCase() || "all";
		if (fork !== "all" && fork !== "none" && (!/^\d+$/.test(fork) || !Number.isSafeInteger(Number(fork)) || Number(fork) < 1)) {
			throw new Error("fork_turns must be `none`, `all`, or a positive integer string");
		}
		const source = this.options.getHistory(parent.name);
		const history = fork === "none" ? [] : fork === "all" ? source : source.slice(-Number(fork));
		const agent: Agent = { name, parent: parent.name, status: "pending_init", active: true,
			mailbox: [this.message("NEW_TASK", parent.name, name, args.message, args.encrypted)],
			delivered: new Set(), generation: 0, waiters: new Set() };
		this.agents.set(name, agent);
		const initialization = Promise.resolve().then(async () => {
			if (this.disposed) return;
			try {
				agent.handle = await this.options.createWorker({ name, parent: parent.name, history });
				if (this.disposed) {
					await agent.handle.dispose();
					agent.handle = undefined;
					return;
				}
				if (!agent.active) return;
				agent.status = "running";
				void this.runCallback(agent, () => agent.handle!.startTask(agent.generation));
			} catch (error) { this.fail(name, error, 0); }
		});
		this.initializing.add(initialization);
		void initialization.finally(() => this.initializing.delete(initialization));
		return { task_name: name };
	}

	sendMessage(caller: string, target: string, message: string, encrypted = false): void {
		const recipient = this.resolve(caller, target);
		this.enqueue(recipient, this.message("MESSAGE", caller, recipient.name, message, encrypted));
	}

	followupTask(caller: string, target: string, message: string, encrypted = false): void {
		const recipient = this.resolve(caller, target);
		if (recipient.name === "/root") throw new Error("root is not a spawned agent");
		const mail = this.message("NEW_TASK", caller, recipient.name, message, encrypted);
		if (recipient.active) {
			this.enqueue(recipient, mail);
			return;
		}
		if (!recipient.handle) throw new Error("Agent initialization has not completed; retry after it settles");
		this.reserveCapacity();
		recipient.active = true;
		recipient.status = "running";
		recipient.generation++;
		recipient.mailbox.push(mail);
		this.signal(recipient, "mail");
		void this.runCallback(recipient, () => recipient.handle!.startTask(recipient.generation));
	}

	async waitAgent(caller: string, requestedTimeout?: number, signal?: AbortSignal): Promise<{ message: string; timed_out: boolean }> {
		const agent = this.agent(caller);
		if (requestedTimeout !== undefined && !Number.isSafeInteger(requestedTimeout)) throw new Error("timeout_ms must be an integer");
		if (requestedTimeout !== undefined && requestedTimeout > 3_600_000) throw new Error("timeout_ms must be at most 3600000");
		const timeout = Math.max(10_000, requestedTimeout ?? 30_000);
		const suffix = requestedTimeout !== undefined && requestedTimeout < timeout
			? `\n\nRequested timeout of ${requestedTimeout}ms was clamped to the minimum of ${timeout}ms.` : "";
		return new Promise((resolve, reject) => {
			const finish = (reason: "mail" | "steer" | "abort" | "timeout") => {
				clearTimeout(timer);
				agent.waiters.delete(finish);
				signal?.removeEventListener("abort", abort);
				if (reason === "abort") { reject(new Error("Wait aborted")); return; }
				const message = reason === "mail" ? "Wait completed." : reason === "steer" ? "Wait interrupted by new input." : "Wait timed out.";
				resolve({ message: message + suffix, timed_out: reason === "timeout" });
			};
			const abort = () => finish("abort");
			const timer = setTimeout(() => finish("timeout"), timeout);
			agent.waiters.add(finish);
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			else if (agent.mailbox.length || agent.delivered.size) finish("mail");
		});
	}

	steer(caller: string): void { this.signal(this.agent(caller), "steer"); }

	listAgents(pathPrefix?: string): { agents: { agent_name: string; agent_status: AgentStatus }[] } {
		this.assertUsable();
		if (pathPrefix && !/^\/root(?:\/[a-z0-9_]+)*$/.test(pathPrefix)) throw new Error("path_prefix must be a canonical task path without a trailing slash");
		return { agents: [...this.agents.values()]
			.filter(agent => !pathPrefix || agent.name === pathPrefix || agent.name.startsWith(`${pathPrefix}/`))
			.sort((a, b) => a.name.localeCompare(b.name))
			.map(agent => ({ agent_name: agent.name, agent_status: agent.status })) };
	}

	interruptAgent(caller: string, target: string): { previous_status: AgentStatus } {
		const agent = this.resolve(caller, target);
		if (agent.name === "/root" || agent.name === caller) throw new Error("Cannot interrupt root or self");
		const previous_status = agent.status;
		if (agent.active) {
			agent.active = false;
			agent.status = "interrupted";
			agent.generation++;
			this.signal(agent, "abort");
			void this.runCallback(agent, () => agent.handle?.interrupt());
		}
		return { previous_status };
	}

	complete(target: string, answer: string | null, generation: number): void {
		if (!this.isActiveTurn(target, generation)) return;
		const agent = this.agent(target);
		agent.active = false;
		agent.status = { completed: answer };
		agent.generation++;
		this.enqueue(this.agent(agent.parent!), this.message("FINAL_ANSWER", agent.name, agent.parent!, answer ?? "", false));
	}

	fail(target: string, error: unknown, generation: number): void {
		if (!this.isActiveTurn(target, generation)) return;
		const agent = this.agent(target);
		const text = error instanceof Error ? error.message : String(error);
		agent.active = false;
		agent.status = { errored: text };
		agent.generation++;
		this.signal(agent, "abort");
		if (agent.parent) this.enqueue(this.agent(agent.parent), this.message("FINAL_ANSWER", agent.name, agent.parent, `Agent errored: ${text.slice(0, 3600)}\n\nThis agent's turn failed. If you still need this agent, use the available collaboration tools to give it another task.`, false));
	}

	drainMailbox(target: string): NativeAgentMessageRecord[] {
		const agent = this.agent(target);
		const records = agent.mailbox.splice(0);
		for (const record of records) agent.delivered.add(record);
		return records;
	}

	/** Steering remains pending until its marker is restored into a model request. */
	acknowledgeDelivery(target: string, record: NativeAgentMessageRecord): void { this.agent(target).delivered.delete(record); }

	isActiveTurn(target: string, generation: number): boolean {
		if (this.disposed) return false;
		const agent = this.agent(target);
		return agent.active && agent.generation === generation;
	}

	setRootStatus(status: AgentStatus): void {
		if (this.disposed) return;
		const root = this.agent("/root");
		root.active = status === "running";
		root.status = status;
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		for (const agent of this.agents.values()) this.signal(agent, "abort");
		await Promise.allSettled([...this.initializing]);
		await Promise.allSettled([...this.agents.values()].map(async agent => { await agent.handle?.dispose(); }));
	}

	private enqueue(agent: Agent, message: NativeAgentMessageRecord): void {
		agent.mailbox.push(message);
		this.signal(agent, "mail");
		if (agent.name === "/root") void this.runCallback(agent, () => this.options.notifyRoot());
		else if (agent.active) void this.runCallback(agent, () => agent.handle?.deliver());
	}

	private async runCallback(agent: Agent, callback: () => void | Promise<void>): Promise<void> {
		const generation = agent.generation;
		try { await callback(); }
		catch (error) { this.fail(agent.name, error, generation); }
	}

	private message(type: MessageType, author: string, recipient: string, message: string, encrypted: boolean): NativeAgentMessageRecord {
		const envelope = `Message Type: ${type}\nTask name: ${recipient}\nSender: ${author}\nPayload:\n`;
		return { type: "agent_message", author, recipient, content: encrypted
			? [{ type: "input_text", text: envelope }, { type: "encrypted_content", encrypted_content: message }]
			: [{ type: "input_text", text: envelope + message }] };
	}

	private resolve(caller: string, target: string): Agent {
		const name = target.startsWith("/") ? target : `${caller}/${target}`;
		if (!/^\/root(?:\/[a-z0-9_]+)*$/.test(name)) throw new Error(`Invalid agent path: ${target}`);
		return this.agent(name);
	}

	private agent(name: string): Agent {
		this.assertUsable();
		const agent = this.agents.get(name);
		if (!agent) throw new Error(`Agent not found: ${name}`);
		return agent;
	}

	private signal(agent: Agent, reason: "mail" | "steer" | "abort"): void {
		for (const wake of [...agent.waiters]) wake(reason);
	}

	private reserveCapacity(): void {
		if ([...this.agents.values()].filter(agent => agent.name !== "/root" && agent.active).length >= this.options.maxActive) {
			throw new Error(`Maximum active agents (${this.options.maxActive}) reached`);
		}
	}

	private assertUsable(): void { if (this.disposed) throw new Error("Coordinator is disposed"); }
}
