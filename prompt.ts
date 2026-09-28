import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";

function textFromUser(message: UserMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.map((part) => (part.type === "text" ? part.text : `[image: ${part.mimeType}]`))
		.join("\n");
}

function textFromAssistant(message: AssistantMessage): string {
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") parts.push(block.text);
		if (block.type === "toolCall") {
			parts.push(`[tool call: ${block.name} ${JSON.stringify(block.arguments)}]`);
		}
	}
	return parts.join("\n");
}

function textFromToolResult(message: ToolResultMessage): string {
	return message.content
		.map((part) => (part.type === "text" ? part.text : `[image: ${part.mimeType}]`))
		.join("\n");
}

function messageBlock(message: AgentMessage): string | undefined {
	if (message.role === "user") return `<message role="user">\n${textFromUser(message)}\n</message>`;
	if (message.role === "assistant") {
		return `<message role="assistant">\n${textFromAssistant(message)}\n</message>`;
	}
	if (message.role === "toolResult") {
		return `<message role="tool" name="${message.toolName}" error="${message.isError}">\n${textFromToolResult(message)}\n</message>`;
	}
	return undefined;
}

export function serializeParentThread(entries: SessionEntry[], maxChars: number): string {
	const blocks = entries.flatMap((entry) => sessionEntryToContextMessages(entry)).map(messageBlock).filter(Boolean) as string[];
	if (blocks.length === 0) return "(parent thread is empty)";

	const selected: string[] = [];
	let used = 0;
	for (let index = blocks.length - 1; index >= 0; index--) {
		const block = blocks[index];
		const cost = block.length + (selected.length > 0 ? 2 : 0);
		if (used + cost > maxChars) {
			if (selected.length === 0) selected.unshift(block.slice(-maxChars));
			selected.unshift("[earlier parent-thread content omitted]");
			break;
		}
		selected.unshift(block);
		used += cost;
	}
	return selected.join("\n\n");
}

export function buildOracleInput(task: string, parentTranscript: string): string {
	return `You are the paired Oracle for another coding agent. The active parent-thread transcript is supplied for context. Inspect the workspace, including read-only Git commands, when that materially improves the answer.

<parent_thread>
${parentTranscript}
</parent_thread>

<oracle_task>
${task}
</oracle_task>

Answer the oracle task directly. Return only your final advisory answer; do not address the parent agent as a user and do not reproduce these wrapper instructions.`;
}

export function buildTaskInput(description: string, prompt: string): string {
	return `You are an isolated execution worker with a fresh conversation. Complete the bounded delegated task below, using the workspace and tools available to you.

<task_description>
${description}
</task_description>

<task>
${prompt}
</task>

Do the work rather than merely proposing it. Verify the result where possible. Return a concise final summary containing the outcome, files changed, verification run, and any unresolved blocker. Only the final summary is returned to the parent agent.`;
}
