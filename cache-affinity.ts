import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CACHE_KEY_ENV = "PI_DIAL_PROMPT_CACHE_KEY";
const OPENAI_APIS = new Set(["openai-responses", "openai-codex-responses"]);

/** Give fresh child sessions a shared cache affinity without changing their transcript identity. */
export default function cacheAffinityExtension(pi: ExtensionAPI): void {
	pi.on("before_provider_request", (event, ctx) => {
		const cacheKey = process.env[CACHE_KEY_ENV];
		if (!cacheKey || !ctx.model || !OPENAI_APIS.has(ctx.model.api)) return;
		if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) return;
		return { ...event.payload, prompt_cache_key: cacheKey };
	});
}
