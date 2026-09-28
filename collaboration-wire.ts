import type { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { collaborationTools } from "./collaboration-tools.ts";

export interface NativeAgentMessageRecord {
	type: "agent_message";
	id?: string;
	author: string;
	recipient: string;
	content: readonly (
		| { type: "input_text"; text: string }
		| { type: "encrypted_content"; encrypted_content: string }
	)[];
	internal_chat_message_metadata_passthrough?: Record<string, unknown>;
}

export interface NativeFunctionCallRecord {
	type: "function_call";
	id?: string;
	call_id: string;
	name: string;
	namespace?: string;
	/** Preserve the provider's raw JSON, including encrypted message bodies. */
	arguments: string;
	/** An absent field selects encryption; an empty array selects plaintext. */
	encrypted_function_args?: readonly string[];
	internal_chat_message_metadata_passthrough?: Record<string, unknown>;
}

export interface NativeCollaborationSidecar {
	agentMessages: Map<string, NativeAgentMessageRecord>;
	functionCalls: Map<string, NativeFunctionCallRecord>;
}

export interface CollaborationPayload {
	input: (ReturnType<typeof convertResponsesMessages>[number] | NativeAgentMessageRecord)[];
	[key: string]: unknown;
}

export function createNativeCollaborationSidecar(): NativeCollaborationSidecar {
	return { agentMessages: new Map(), functionCalls: new Map() };
}

export function nativeFunctionCallKey(callId: string, itemId?: string): string {
	return JSON.stringify([callId, itemId ?? null]);
}

export function putNativeAgentMessage(sidecar: NativeCollaborationSidecar, marker: string, record: NativeAgentMessageRecord): void {
	sidecar.agentMessages.set(marker, structuredClone(record));
}

export function putNativeFunctionCall(sidecar: NativeCollaborationSidecar, record: NativeFunctionCallRecord): NativeFunctionCallRecord {
	const captured = structuredClone(record);
	sidecar.functionCalls.set(nativeFunctionCallKey(record.call_id, record.id), captured);
	return captured;
}

export function convertCollaborationPayload(
	payload: CollaborationPayload,
	sidecar: NativeCollaborationSidecar,
	onAgentMessageRestored?: (marker: string) => void,
): CollaborationPayload {
	const nativeCalls = new Map<string, NativeFunctionCallRecord>();
	const input = payload.input.map(item => {
		if ("role" in item && item.role === "user" && Array.isArray(item.content) && item.content.length === 1 && item.content[0].type === "input_text") {
			const marker = item.content[0].text;
			const message = sidecar.agentMessages.get(marker);
			if (message) {
				onAgentMessageRestored?.(marker);
				return structuredClone(message);
			}
		}
		if (item.type === "function_call") {
			const call = sidecar.functionCalls.get(nativeFunctionCallKey(item.call_id, item.id));
			if (call) {
				nativeCalls.set(call.call_id, call);
				return structuredClone(call);
			}
		}
		if (item.type !== "function_call_output" || typeof item.output !== "string") return item;
		const call = nativeCalls.get(item.call_id);
		if (!call) return item;
		if (["send_message", "followup_task"].includes(call.name) && item.output === "(no tool output)") {
			return { ...item, output: "" };
		}
		if (collaborationTools.find(tool => tool.name === call.name)?.output_schema) {
			try { JSON.parse(item.output); }
			catch { return { ...item, output: JSON.stringify({ error: item.output }) }; }
		}
		return item;
	});
	return { ...payload, input };
}
