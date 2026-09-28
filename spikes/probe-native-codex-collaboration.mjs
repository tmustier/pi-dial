#!/usr/bin/env node
/**
 * Opt-in live compatibility probe. It makes at most three tiny Codex requests.
 *
 * Usage:
 *   PI_AI_ROOT=/path/to/pi-coding-agent/node_modules/@earendil-works/pi-ai \
 *     node spikes/probe-native-codex-collaboration.mjs
 *
 * The probe asks `pi auth` for the existing openai-codex bearer token in memory.
 * It never prints the token, credential files, request headers, or full payloads.
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const piAiRoot = process.env.PI_AI_ROOT;
if (!piAiRoot) {
	console.error("PI_AI_ROOT is required; point it at the pi-ai nested under the Pi CLI being tested");
	process.exit(2);
}

let bearer;
try {
	bearer = execFileSync("pi", ["auth", "print-bearer-token", "--provider", "openai-codex"], {
		encoding: "utf8",
		timeout: 20_000,
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
	if (!bearer) throw new Error("Pi returned an empty bearer token");
} catch (error) {
	console.error(JSON.stringify({ accepted: false, stage: "auth", error: safeError(error) }));
	process.exit(1);
}

const [{ streamSimple }, { getBuiltinModels }, nativeStreamModule, wireModule] = await Promise.all([
	import(pathToFileURL(resolve(piAiRoot, "dist/api/openai-codex-responses.js"))),
	import(pathToFileURL(resolve(piAiRoot, "dist/providers/all.js"))),
	import("../collaboration-stream.ts"),
	import("../collaboration-wire.ts"),
]);
const modelTemplate = getBuiltinModels("openai-codex").find(model => model.api === "openai-codex-responses");
if (!modelTemplate) throw new Error("No OpenAI Codex Responses model is available as a probe template");
const model = { ...modelTemplate, id: "gpt-6-sol", name: "GPT-6 Sol" };

async function request(name, context, transform, streamFn = streamSimple) {
	let status;
	try {
		const events = streamFn(model, context, {
			apiKey: bearer,
			maxTokens: 96,
			reasoning: "minimal",
			maxRetries: 0,
			timeoutMs: 60_000,
			transport: "sse",
			onPayload: transform ? (payload) => transform(structuredClone(payload)) : undefined,
			onResponse(response) {
				status = response.status;
			},
		});
		let message;
		for await (const event of events) {
			if (event.type === "done") message = event.message;
			if (event.type === "error") throw new Error(event.error.errorMessage ?? event.reason);
		}
		if (!message) throw new Error("Codex stream ended without a final message");
		return { name, accepted: true, httpStatus: status, message };
	} catch (error) {
		return { name, accepted: false, httpStatus: status, error: safeError(error) };
	}
}

const agentMessage = process.env.PROBE_NATIVE_ONLY === "1" ? undefined : await request(
	"agent_message_input",
	{
		systemPrompt: "This is a transport compatibility probe. Follow the fixed input instruction and do nothing else.",
		messages: [{ role: "user", content: "placeholder", timestamp: Date.now() }],
	},
	(payload) => ({
		...payload,
		tool_choice: "none",
		tools: [],
		input: [{
			type: "agent_message",
			author: "/root/probe-child",
			recipient: "/root",
			content: [{
				type: "input_text",
				text: "Message Type: MESSAGE\nTask name: /root\nSender: /root/probe-child\nPayload:\nReply exactly AGENT_MESSAGE_ACCEPTED",
			}],
		}],
	}),
);

const sidecar = wireModule.createNativeCollaborationSidecar();
const nativeStream = nativeStreamModule.createNativeCodexStream({ sidecar });
const namespaceTool = await request(
	"namespace_encrypted_message_schema",
	{
		systemPrompt: "Call collaboration.send_message once with target /root/child and message exactly probe-payload.",
		messages: [{ role: "user", content: "Call the tool now.", timestamp: Date.now() }],
		tools: [{
			name: "send_message",
			description: "Send a message to an existing agent. The message will be delivered promptly. Does not trigger a new turn.",
			parameters: {
				type: "object",
				properties: {
					target: { type: "string", description: "Relative or canonical task name to message." },
					message: { type: "string", encrypted: true, description: "Message text to queue on the target agent." },
				},
				required: ["target", "message"],
				additionalProperties: false,
			},
		}],
	},
	undefined,
	nativeStream,
);

const agentText = agentMessage?.accepted
	? agentMessage.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")
	: undefined;
const toolCall = namespaceTool.accepted
	? namespaceTool.message.content.find((part) => part.type === "toolCall")
	: undefined;
const returnedMessage = toolCall?.arguments?.message;
const rawCall = sidecar.functionCalls.values().next().value;

const relay = typeof returnedMessage === "string" && rawCall ? await request(
	"encrypted_agent_message_relay",
	{
		systemPrompt: "You are /root/child. Read the native message from /root and return only its Payload text, verbatim. No tools.",
		messages: [{ role: "user", content: "placeholder", timestamp: Date.now() }],
	},
	payload => ({ ...payload, tool_choice: "none", tools: [], input: [
		rawCall,
		{ type: "function_call_output", call_id: rawCall.call_id, output: "" },
		{
		type: "agent_message", author: "/root", recipient: "/root/child",
		content: [
			{ type: "input_text", text: "Message Type: MESSAGE\nTask name: /root/child\nSender: /root\nPayload:\n" },
			{ type: "encrypted_content", encrypted_content: returnedMessage },
		],
	}] }), nativeStream,
) : undefined;
const relayText = relay?.accepted ? relay.message.content.filter(part => part.type === "text").map(part => part.text).join("\n").trim() : undefined;
const report = {
	model: "openai-codex/gpt-6-sol",
	requestsMade: (agentMessage ? 2 : 1) + (relay ? 1 : 0),
	agentMessage: agentMessage?.accepted
		? {
			accepted: true,
			httpStatus: agentMessage.httpStatus,
			observedText: agentText,
			exactCanary: agentText?.trim() === "AGENT_MESSAGE_ACCEPTED",
		}
		: agentMessage ?? { skipped: true },
	namespaceEncryptedMessageSchema: namespaceTool.accepted
		? {
			accepted: true,
			httpStatus: namespaceTool.httpStatus,
			toolCallObserved: Boolean(toolCall),
			name: toolCall?.name,
			namespace: toolCall?.namespace,
			argumentMessage: typeof returnedMessage === "string"
				? { equalsPlaintextCanary: returnedMessage === "probe-payload", length: returnedMessage.length }
				: { observedType: typeof returnedMessage },
			rawCapture: rawCall ? {
				rawArgumentsCaptured: typeof rawCall.arguments === "string",
				encryptedFunctionArgsPresent: Object.hasOwn(rawCall, "encrypted_function_args"),
				encryptedFunctionArgs: rawCall.encrypted_function_args,
				metadataPresent: Object.hasOwn(rawCall, "internal_chat_message_metadata_passthrough"),
			} : { observed: false },
		}
		: namespaceTool,
	encryptedRelay: relay?.accepted ? { accepted: true, httpStatus: relay.httpStatus, exactCanary: relayText === "probe-payload", nativeCallReplayAccepted: true } : relay ?? { skipped: true },
};
console.log(JSON.stringify(report, null, 2));
process.exitCode = (agentMessage ? agentText?.trim() === "AGENT_MESSAGE_ACCEPTED" : true) && toolCall?.namespace === "collaboration" && relayText === "probe-payload" ? 0 : 1;

function safeError(error) {
	let text = error instanceof Error ? error.message : String(error);
	if (bearer) text = text.split(bearer).join("[redacted]");
	return text;
}
