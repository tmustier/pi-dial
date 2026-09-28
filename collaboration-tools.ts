export interface CollaborationToolDefinition {
	name: "spawn_agent" | "send_message" | "followup_task" | "wait_agent" | "list_agents" | "interrupt_agent";
	description: string;
	strict: false;
	parameters: Record<string, unknown>;
	output_schema?: Record<string, unknown>;
}

const string = (description: string, encrypted = false) => ({ type: "string", description, ...(encrypted ? { encrypted: true } : {}) });
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
	type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false,
});
const status = {
	oneOf: [
		{ type: "string", enum: ["pending_init", "running", "interrupted", "shutdown", "not_found"] },
		object({ completed: { type: ["string", "null"] } }, ["completed"]),
		object({ errored: { type: "string" } }, ["errored"]),
	],
};

/** The six model-facing Codex V2 collaboration tools. No transport or SDK registration is performed here. */
export const collaborationTools: readonly CollaborationToolDefinition[] = [
	{
		name: "spawn_agent",
		description: "Spawn a new agent for a concrete, bounded subtask that can run independently alongside useful local work. Returns immediately with its canonical task path. Children inherit active built-in coding tools and can spawn children; parent extension tools are not inherited. Use a short child name locally or a canonical path across branches. The child can message other agents and its final answer goes to its parent.",
		strict: false,
		parameters: object({
			task_name: string("Task name for the new agent. Use lowercase letters, digits, and underscores."),
			message: string("Initial plain-text task for the new agent.", true),
			fork_turns: string("Optional number of turns to fork. Defaults to `all`. Use `none`, `all`, or a positive integer string such as `3` to fork only the most recent turns."),
		}, ["task_name", "message"]),
		output_schema: object({ task_name: string("Canonical task name for the spawned agent.") }, ["task_name"]),
	},
	{
		name: "send_message",
		description: "Send a message to an existing agent. The message will be delivered promptly. Does not trigger a new turn.",
		strict: false,
		parameters: object({ target: string("Relative or canonical task name to message (from spawn_agent)."), message: string("Message text to queue on the target agent.", true) }, ["target", "message"]),
	},
	{
		name: "followup_task",
		description: "Send a follow-up task to an existing non-root target agent and trigger a turn if it is idle. If the target is already running, deliver the task promptly at message boundaries while sampling, or after the pending tool call completes.",
		strict: false,
		parameters: object({ target: string("Agent id or canonical task name to send a follow-up task to."), message: string("Message text to send to the target agent.", true) }, ["target", "message"]),
	},
	{
		name: "wait_agent",
		description: "Wait for a mailbox update from any live agent, including queued messages and final-status notifications. The wait also ends early when new user input is steered into the active turn. Does not return the content; returns either a summary of which agents have updates (if any), an interruption summary for steered input, or a timeout summary if no activity arrives before the deadline.",
		strict: false,
		parameters: object({ timeout_ms: { type: "number", description: "Timeout in milliseconds. Defaults to 30000, min 10000, max 3600000." } }),
		output_schema: object({ message: string("Brief wait summary without message content."), timed_out: { type: "boolean" } }, ["message", "timed_out"]),
	},
	{
		name: "list_agents",
		description: "List live agents in the current root thread tree. Optionally filter by task-path prefix.",
		strict: false,
		parameters: object({ path_prefix: string("Task-path prefix filter without a trailing slash.") }),
		output_schema: object({ agents: { type: "array", items: object({ agent_name: string("Canonical task name."), agent_status: status }, ["agent_name", "agent_status"]) } }, ["agents"]),
	},
	{
		name: "interrupt_agent",
		description: "Interrupt an agent's current turn, if any, and return its previous status. The agent remains available for messages and follow-up tasks.",
		strict: false,
		parameters: object({ target: string("Agent id or canonical task name to interrupt.") }, ["target"]),
		output_schema: object({ previous_status: status }, ["previous_status"]),
	},
];
