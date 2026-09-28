import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";

export function gpt6SolModel(): Model<Api> {
	const template = getModels("openai-codex").find(
		(model) => model.api === "openai-codex-responses" && model.thinkingLevelMap?.medium === "medium",
	);
	if (!template) throw new Error("No OpenAI Codex Responses model is available as a test template");
	return { ...template, id: "gpt-6-sol", name: "GPT-6 Sol" } as Model<Api>;
}
