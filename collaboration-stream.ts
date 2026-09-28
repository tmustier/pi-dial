import {
	clampThinkingLevel,
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { formatProviderError, normalizeProviderError } from "@earendil-works/pi-ai/utils/error-body";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import {
	convertResponsesMessages,
	convertResponsesTools,
	processResponsesStream,
} from "@earendil-works/pi-ai/api/openai-responses-shared";
import { convertCollaborationPayload, putNativeFunctionCall, type CollaborationPayload, type NativeCollaborationSidecar, type NativeFunctionCallRecord } from "./collaboration-wire.ts";
import { collaborationTools } from "./collaboration-tools.ts";

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
const ACCOUNT_CLAIM = "https://api.openai.com/auth";
const COLLABORATION_TOOLS = new Set<string>(collaborationTools.map(tool => tool.name));

export interface NativeCodexStreamOptions {
	sidecar: NativeCollaborationSidecar;
	onNativeFunctionCall?: (record: NativeFunctionCallRecord) => void | Promise<void>;
	onAgentMessageRestored?: (marker: string) => void;
	/** Used by the host to keep mail arriving during a final answer queue-only. */
	onResponsePhase?: (phase: "sampling" | "final" | "idle") => void;
	/** Return true only after host mail has been queued as Pi steering. */
	yieldAtMessageBoundary?: () => boolean;
}

type RawEvent = { type: string; [key: string]: any };
export function createNativeCodexStream(nativeOptions: NativeCodexStreamOptions) {
	return (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream => {
		const stream = createAssistantMessageEventStream();
		void runNativeCodexStream(stream, model, context, options, nativeOptions);
		return stream;
	};
}

async function runNativeCodexStream(
	stream: AssistantMessageEventStream,
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	nativeOptions: NativeCodexStreamOptions,
): Promise<void> {
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};

	try {
		nativeOptions.onResponsePhase?.("sampling");
		if (model.api !== "openai-codex-responses") throw new Error(`Unsupported native Codex API: ${model.api}`);
		if (!options?.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
		if (options.signal?.aborted) throw new Error("Request was aborted");

		let body: unknown = convertCollaborationPayload(buildRequestBody(model, context, options), nativeOptions.sidecar, nativeOptions.onAgentMessageRestored);
		body = (await options.onPayload?.(body, model)) ?? body;
		const response = await fetchSSE(model, body, options);
		await options.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model);
		if (!response.ok) {
			let message = (await response.text()).slice(0, 2_000) || response.statusText;
			try {
				const body = JSON.parse(message);
				const detail = body?.error?.message ?? body?.message;
				if (typeof detail === "string") message = detail;
			} catch {}
			throw new Error(`Codex API error (${response.status}): ${message}`);
		}
		if (!response.body) throw new Error("Codex returned no response body");

		stream.push({ type: "start", partial: output });
		const events = readCodexEvents(parseSSE(response, options.signal), nativeOptions);
		await processResponsesStream(events, output, stream, model);
		if (options.signal?.aborted) throw new Error("Request was aborted");
		if (output.stopReason === "pending") throw new Error("Codex stream ended without a stop reason");
		if (output.stopReason === "error" || output.stopReason === "aborted") {
			throw new Error(output.errorMessage || "Codex request failed");
		}
		stream.push({ type: "done", reason: output.stopReason, message: output });
		stream.end();
	} catch (error) {
		for (const block of output.content) {
			if (block.type === "toolCall") delete (block as { partialJson?: string }).partialJson;
		}
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = formatProviderError(normalizeProviderError(error));
		stream.push({ type: "error", reason: output.stopReason, error: output });
		stream.end();
	} finally {
		nativeOptions.onResponsePhase?.("idle");
	}
}

function buildRequestBody(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions): CollaborationPayload {
	const compat = model.compat as { supportsStrictMode?: boolean; supportsOpenAIGrammarTools?: boolean } | undefined;
	const clampedReasoning = options.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning && clampedReasoning !== "off"
		? (model.thinkingLevelMap?.[clampedReasoning] ?? clampedReasoning)
		: undefined;
	const input = convertResponsesMessages(model, context, new Set(["openai", "openai-codex", "opencode"]), {
		includeSystemPrompt: false,
		toolOptions: { strict: null, supportsStrictMode: compat?.supportsStrictMode ?? true },
	});
	const ordinaryTools = convertResponsesTools(getCurrentTools(context.messages), {
		strict: null,
		supportsStrictMode: compat?.supportsStrictMode ?? true,
		supportsOpenAIGrammarTools: compat?.supportsOpenAIGrammarTools ?? false,
	}) as unknown as Array<Record<string, unknown>>;
	const collaboration = ordinaryTools.filter(
		(tool) => tool.type === "function" && typeof tool.name === "string" && COLLABORATION_TOOLS.has(tool.name),
	);
	const tools = ordinaryTools.filter((tool) => !collaboration.includes(tool));
	if (collaboration.length) {
		tools.push({ type: "namespace", name: "collaboration", description: "Agent collaboration tools.", tools: collaboration.map(tool => {
			const spec = collaborationTools.find(spec => spec.name === tool.name)!;
			return { ...tool, strict: false, ...(spec.output_schema ? { output_schema: spec.output_schema } : {}) };
		}) });
	}

	return {
		model: model.id,
		store: false,
		stream: true,
		instructions: getCurrentSystemPrompt(context.messages) || "You are a helpful assistant.",
		input,
		text: { verbosity: "low" },
		include: ["reasoning.encrypted_content"],
		...(options.cacheRetention !== "none" && options.sessionId ? { prompt_cache_key: options.sessionId } : {}),
		...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
		tool_choice: options.toolChoice ?? "auto",
		parallel_tool_calls: true,
		...(tools.length ? { tools } : {}),
		...(reasoningEffort ? { reasoning: { effort: reasoningEffort, summary: "auto" } } : {}),
	};
}

async function fetchSSE(
	model: Model<Api>,
	body: unknown,
	options: SimpleStreamOptions,
): Promise<Response> {
	let accountId: string;
	try {
		const claims = JSON.parse(Buffer.from(options.apiKey!.split(".")[1], "base64url").toString("utf8"));
		accountId = claims[ACCOUNT_CLAIM]?.chatgpt_account_id;
		if (typeof accountId !== "string" || !accountId) throw new Error();
	} catch {
		throw new Error("Failed to extract accountId from token");
	}
	const headers = new Headers(model.headers);
	for (const [name, value] of Object.entries(options.headers ?? {})) {
		if (value === null) headers.delete(name);
		else headers.set(name, value);
	}
	headers.set("authorization", `Bearer ${options.apiKey}`);
	headers.set("chatgpt-account-id", accountId);
	headers.set("originator", "pi");
	headers.set("openai-beta", "responses=experimental");
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");
	if (options.sessionId) {
		headers.set("session-id", options.sessionId);
		headers.set("x-client-request-id", options.sessionId);
	}

	const timeout = options.timeoutMs && options.timeoutMs > 0 ? AbortSignal.timeout(options.timeoutMs) : undefined;
	const signal = AbortSignal.any([options.signal, timeout].filter((signal): signal is AbortSignal => signal !== undefined));
	let url = (model.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
	if (!url.endsWith("/codex/responses")) url += url.endsWith("/codex") ? "/responses" : "/codex/responses";
	try {
		return await (options.fetch ?? globalThis.fetch)(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal,
		});
	} catch (error) {
		if (options.signal?.aborted) throw new Error("Request was aborted");
		if (timeout?.aborted) throw new Error(`Codex SSE response headers timed out after ${options.timeoutMs}ms`);
		throw error;
	}
}

async function* parseSSE(response: Response, signal?: AbortSignal): AsyncGenerator<RawEvent> {
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const abort = () => void reader.cancel().catch(() => {});
	signal?.addEventListener("abort", abort, { once: true });
	try {
		while (true) {
			if (signal?.aborted) throw new Error("Request was aborted");
			const { done, value } = await reader.read();
			buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
			buffer = buffer.replace(/\r\n/g, "\n");
			if (done && buffer.trim()) buffer += "\n\n";
			let boundary: number;
			while ((boundary = buffer.indexOf("\n\n")) !== -1) {
				const frame = buffer.slice(0, boundary).replace(/\r/g, "");
				buffer = buffer.slice(boundary + 2);
				const data = frame.split("\n").filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trim()).join("\n").trim();
				if (!data || data === "[DONE]") continue;
				try { yield JSON.parse(data) as RawEvent; }
				catch (cause) { throw new Error(`Invalid Codex SSE JSON: ${cause instanceof Error ? cause.message : String(cause)}`); }
			}
			if (done) return;
		}
	} finally {
		signal?.removeEventListener("abort", abort);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

async function* readCodexEvents(
	events: AsyncIterable<RawEvent>,
	options: NativeCodexStreamOptions,
): AsyncGenerator<any> {
	const openItems = new Set<number>();
	let finalStarted = false;
	for await (const event of events) {
		if (event.type === "error") throw new Error(`Codex error: ${event.message ?? event.error?.message ?? event.code ?? event.error?.code ?? "unknown"}`);
		if (event.type === "response.failed") throw new Error(event.response?.error?.message ?? "Codex response failed");
		if (event.type === "response.done" || event.type === "response.completed" || event.type === "response.incomplete") {
			yield { ...event, type: "response.completed" };
			return;
		}
		if (event.type === "response.output_item.added") {
			openItems.add(event.output_index);
			if (event.item?.type === "message" && event.item.channel !== "commentary" && event.item.phase !== "commentary") {
				finalStarted = true;
				options.onResponsePhase?.("final");
			}
		}
		if (event.type === "response.output_item.done") openItems.delete(event.output_index);
		const item = event.type === "response.output_item.done" ? event.item : undefined;
		if (item?.type === "function_call" && item.namespace === "collaboration" && COLLABORATION_TOOLS.has(item.name)) {
			const record = putNativeFunctionCall(options.sidecar, {
				type: "function_call", id: item.id, call_id: item.call_id,
				name: item.name, namespace: item.namespace, arguments: item.arguments,
				...(Object.hasOwn(item, "encrypted_function_args") ? { encrypted_function_args: item.encrypted_function_args } : {}),
				...(Object.hasOwn(item, "internal_chat_message_metadata_passthrough")
					? { internal_chat_message_metadata_passthrough: item.internal_chat_message_metadata_passthrough } : {}),
			});
			await options.onNativeFunctionCall?.(record);
		}
		yield event;
		const boundary = item?.type === "reasoning" || (item?.type === "message" && (item.channel === "commentary" || item.phase === "commentary"));
		if (boundary && !finalStarted && openItems.size === 0 && options.yieldAtMessageBoundary?.()) {
			// Pi consumes the queued steering message after this response ends.
			yield { type: "response.completed", response: { status: "completed", output: [], usage: {} } };
			return;
		}
	}
	throw new Error("Codex SSE ended before a terminal response event");
}
