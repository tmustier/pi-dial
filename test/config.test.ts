import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDefaultConfig, loadDialConfig, splitModelSpec } from "../config.ts";

const extensionDir = join(import.meta.dirname, "..");

test("default config reproduces the current four-position dial matrix", () => {
	const config = createDefaultConfig(extensionDir);
	assert.deepEqual(config.order, ["low", "medium", "high", "ultra"]);
	assert.equal(config.shortcut, "ctrl+shift+u");
	assert.deepEqual(
		Object.fromEntries(
			config.order.map((mode) => [mode, [config.modes[mode].model, config.modes[mode].thinking]]),
		),
		{
			low: ["anthropic/claude-opus-5-5", "medium"],
			medium: ["openai-codex/gpt-6-sol", "medium"],
			high: ["openai-codex/gpt-6-sol", "xhigh"],
			ultra: ["anthropic/claude-fable-5-1", "high"],
		},
	);
	assert.deepEqual(config.modes.low.fallbacks, []);
	for (const mode of ["low", "medium", "high", "ultra"]) {
		const oracle = config.modes[mode].oracle;
		assert.ok(oracle);
		assert.equal(oracle.thinking, "high");
		if (mode === "low" || mode === "medium") assert.equal(oracle.model, "openai-codex/gpt-6-astra");
	}
	assert.equal(config.modes.high.oracle && config.modes.high.oracle.model, "anthropic/claude-fable-5-1");
	assert.equal(config.modes.ultra.oracle && config.modes.ultra.oracle.model, "openai-codex/gpt-6-sol");
	assert.deepEqual(config.childRouting, { oracle: [], task: [] });
	assert.deepEqual(config.modes.ultra.fallbacks, []);
});

test("removed mode prompt keys fail with a migration message", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dial-config-"));
	try {
		for (const [name, layer, pattern] of [
			["parent.json", { parentPrompt: "dial" }, /parentPrompt: mode prompts were removed/],
			["context.json", { includeRuntimeContext: true }, /includeRuntimeContext: mode prompts were removed/],
			["mode.json", { modes: { medium: { promptFile: "x.md" } } }, /modes\.medium\.promptFile: mode prompts were removed/],
		] as const) {
			writeFileSync(join(dir, name), JSON.stringify(layer));
			assert.throws(() => loadDialConfig(extensionDir, [{ path: join(dir, name), required: true }]), pattern);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("default config defines inactive Oracle and Task fallbacks", () => {
	const config = createDefaultConfig(extensionDir);
	const oracle = config.inactive.oracle;
	if (oracle === false) assert.fail("the inactive Oracle fallback should be enabled by default");
	assert.deepEqual(oracle.fallbacks, [
		{ model: "anthropic/claude-fable-5-1", thinking: "high" },
		{ model: "openai-codex/gpt-6-sol", thinking: "xhigh" },
	]);
	assert.match(oracle.promptFile ?? "", /oracle\.md$/);
	assert.deepEqual(oracle.tools, ["read", "bash", "grep", "find", "ls"]);
	const task = config.inactive.task;
	if (task === false) assert.fail("the inactive Task fallback should be enabled by default");
	assert.deepEqual(task.fallbacks, [{ model: "openai-codex/gpt-6-sol", thinking: "medium" }]);
	assert.equal(task.commandReviewMs, 2 * 60 * 1000);
	assert.equal(task.promptFile, undefined);
});

test("config layers replace ordered child routing rules with strict validation", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dial-config-"));
	try {
		const path = join(dir, "routing.json");
		writeFileSync(
			path,
			JSON.stringify({
				childRouting: {
					oracle: [
						{
							parentModel: "openrouter/*/claude-*",
							model: "openai-codex/gpt-6-sol",
							thinking: "high",
						},
					],
					task: [],
				},
			}),
		);
		const config = loadDialConfig(extensionDir, [{ path, required: true }]);
		assert.deepEqual(config.childRouting.oracle, [
			{
				parentModel: "openrouter/*/claude-*",
				model: "openai-codex/gpt-6-sol",
				thinking: "high",
			},
		]);

		writeFileSync(path, JSON.stringify({ childRouting: { oracle: [{ parentModel: "claude-*" }] } }));
		assert.throws(
			() => loadDialConfig(extensionDir, [{ path, required: true }]),
			/expected provider\/model/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("config layers adjust or disable the inactive fallbacks with strict validation", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dial-config-"));
	try {
		writeFileSync(
			join(dir, "dial.json"),
			JSON.stringify({
				inactive: {
					oracle: false,
					task: {
						fallbacks: [{ model: "radius/glm-5.2", thinking: "medium" }],
						commandReviewMs: 12_000,
					},
				},
			}),
		);
		const config = loadDialConfig(extensionDir, [{ path: join(dir, "dial.json"), required: true }]);
		assert.equal(config.inactive.oracle, false);
		const task = config.inactive.task;
		if (task === false) assert.fail("the inactive Task fallback should remain enabled");
		assert.deepEqual(task.fallbacks, [{ model: "radius/glm-5.2", thinking: "medium" }]);
		assert.equal(task.commandReviewMs, 12_000);
		assert.equal(task.promptFile, undefined);

		writeFileSync(join(dir, "model-key.json"), JSON.stringify({ inactive: { oracle: { model: "a/b" } } }));
		assert.throws(
			() => loadDialConfig(extensionDir, [{ path: join(dir, "model-key.json"), required: true }]),
			/unknown property "model"/,
		);

		writeFileSync(join(dir, "empty.json"), JSON.stringify({ inactive: { task: { fallbacks: [] } } }));
		assert.throws(
			() => loadDialConfig(extensionDir, [{ path: join(dir, "empty.json"), required: true }]),
			/at least one fallback model is required/,
		);

		writeFileSync(join(dir, "review.json"), JSON.stringify({ inactive: { task: { commandReviewMs: 0 } } }));
		assert.throws(
			() => loadDialConfig(extensionDir, [{ path: join(dir, "review.json"), required: true }]),
			/commandReviewMs: expected a positive integer/,
		);
		writeFileSync(
			join(dir, "review.json"),
			JSON.stringify({ inactive: { task: { commandReviewMs: 2_147_483_648 } } }),
		);
		assert.throws(
			() => loadDialConfig(extensionDir, [{ path: join(dir, "review.json"), required: true }]),
			/commandReviewMs: must not exceed 2147483647/,
		);

		writeFileSync(join(dir, "timeout.json"), JSON.stringify({ inactive: { task: { timeoutMs: 1000 } } }));
		assert.throws(
			() => loadDialConfig(extensionDir, [{ path: join(dir, "timeout.json"), required: true }]),
			/timeoutMs: whole-agent timeouts were removed; delete this key and set task\.commandReviewMs/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("mode-level tool loadout configuration is rejected", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dial-config-"));
	try {
		for (const key of ["tools", "optionalTools"]) {
			writeFileSync(join(dir, "tools.json"), JSON.stringify({ modes: { medium: { [key]: ["read"] } } }));
			assert.throws(
				() => loadDialConfig(extensionDir, [{ path: join(dir, "tools.json"), required: true }]),
				/never manages the main agent's tool loadout/,
			);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("config layers resolve paths relative to their own file and append custom modes", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dial-config-"));
	try {
		writeFileSync(join(dir, "custom.md"), "Custom prompt\n");
		writeFileSync(
			join(dir, "dial.json"),
			JSON.stringify({
				defaultMode: "review",
				shortcut: "ctrl+shift+k",
				modes: {
					medium: { thinking: "high" },
					review: {
						label: "Review",
						description: "Read-only review",
						model: "example/model",
						thinking: "low",
						oracle: false,
						task: { promptFile: "custom.md" },
					},
				},
			}),
		);
		const config = loadDialConfig(extensionDir, [{ path: join(dir, "dial.json"), required: true }]);
		assert.equal(config.defaultMode, "review");
		assert.equal(config.shortcut, "ctrl+shift+k");
		assert.equal(config.modes.medium.thinking, "high");
		const reviewTask = config.modes.review.task;
		assert.equal(reviewTask && reviewTask.promptFile, join(dir, "custom.md"));
		assert.equal(config.order.at(-1), "review");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("config rejects unknown properties instead of silently ignoring typos", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dial-config-"));
	try {
		const path = join(dir, "dial.json");
		writeFileSync(path, JSON.stringify({ modes: { high: { thinkng: "high" } } }));
		assert.throws(() => loadDialConfig(extensionDir, [{ path, required: true }]), /unknown property "thinkng"/);
		writeFileSync(path, JSON.stringify({ modes: { high: { task: { maxConcurrency: 100 } } } }));
		assert.throws(() => loadDialConfig(extensionDir, [{ path, required: true }]), /unknown property "maxConcurrency"/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("config rejects invalid shortcut identifiers", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dial-config-"));
	try {
		const path = join(dir, "dial.json");
		writeFileSync(path, JSON.stringify({ shortcut: "ctrl+not-a-key" }));
		assert.throws(() => loadDialConfig(extensionDir, [{ path, required: true }]), /invalid Pi key identifier/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("model specs split only on the provider separator", () => {
	assert.deepEqual(splitModelSpec("openrouter/vendor/model"), {
		provider: "openrouter",
		modelId: "vendor/model",
	});
	assert.throws(() => splitModelSpec("missing-provider"), /Invalid model spec/);
});

test("default config includes HUD colors, dial placement, and auto-close timing", () => {
	const config = createDefaultConfig(extensionDir);
	assert.equal(config.hudAutoCloseMs, 2400);
	assert.deepEqual(
		Object.fromEntries(config.order.map((mode) => [mode, [config.modes[mode].color, config.modes[mode].dial]])),
		{
			low: ["success", true],
			medium: ["accent", true],
			high: ["thinkingHigh", true],
			ultra: ["thinkingMax", true],
		},
	);
});

test("config layers control HUD color, dial placement, and auto-close", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dial-config-"));
	try {
		writeFileSync(join(dir, "custom.md"), "Custom prompt\n");
		writeFileSync(
			join(dir, "dial.json"),
			JSON.stringify({
				hudAutoCloseMs: false,
				modes: {
					medium: { color: "warning" },
					scout: {
						label: "Scout",
						description: "Off-dial helper",
						color: "mdHeading",
						dial: false,
						model: "example/model",
						thinking: "low",
					},
				},
			}),
		);
		const config = loadDialConfig(extensionDir, [{ path: join(dir, "dial.json"), required: true }]);
		assert.equal(config.hudAutoCloseMs, false);
		assert.equal(config.modes.medium.color, "warning");
		assert.equal(config.modes.medium.dial, true);
		assert.equal(config.modes.scout.color, "mdHeading");
		assert.equal(config.modes.scout.dial, false);

		writeFileSync(join(dir, "bad-color.json"), JSON.stringify({ modes: { medium: { color: "magenta" } } }));
		assert.throws(
			() => loadDialConfig(extensionDir, [{ path: join(dir, "bad-color.json"), required: true }]),
			/expected a Pi theme color name/,
		);

		writeFileSync(
			join(dir, "no-detents.json"),
			JSON.stringify({
				modes: {
					low: { dial: false },
					medium: { dial: false },
					high: { dial: false },
					ultra: { dial: false },
				},
			}),
		);
		assert.throws(
			() => loadDialConfig(extensionDir, [{ path: join(dir, "no-detents.json"), required: true }]),
			/at least one mode must stay on the dial/,
		);

		writeFileSync(join(dir, "bad-auto-close.json"), JSON.stringify({ hudAutoCloseMs: -5 }));
		assert.throws(
			() => loadDialConfig(extensionDir, [{ path: join(dir, "bad-auto-close.json"), required: true }]),
			/expected a positive integer/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an object override re-enables a disabled inactive fallback from the built-in defaults", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dial-config-"));
	try {
		writeFileSync(join(dir, "layer1.json"), JSON.stringify({ inactive: { oracle: false } }));
		writeFileSync(
			join(dir, "layer2.json"),
			JSON.stringify({ inactive: { oracle: { fallbacks: [{ model: "radius/glm-5.2", thinking: "medium" }] } } }),
		);
		const config = loadDialConfig(extensionDir, [
			{ path: join(dir, "layer1.json"), required: true },
			{ path: join(dir, "layer2.json"), required: true },
		]);
		const oracle = config.inactive.oracle;
		if (oracle === false) assert.fail("the re-enabled inactive Oracle fallback should be an object");
		assert.deepEqual(oracle.fallbacks, [{ model: "radius/glm-5.2", thinking: "medium" }]);
		assert.match(oracle.promptFile ?? "", /oracle\.md$/);
		assert.deepEqual(oracle.tools, ["read", "bash", "grep", "find", "ls"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("remapping a model alias moves every default that uses it to the new provider", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dial-config-"));
	try {
		writeFileSync(join(dir, "dial.json"), JSON.stringify({ models: { fable: "example/fable-proxy" } }));
		const config = loadDialConfig(extensionDir, [{ path: join(dir, "dial.json"), required: true }]);
		assert.equal(config.modes.ultra.model, "example/fable-proxy");
		assert.equal(config.modes.high.oracle && config.modes.high.oracle.model, "example/fable-proxy");
		assert.equal(config.inactive.oracle && config.inactive.oracle.fallbacks[0].model, "example/fable-proxy");
		assert.equal(config.modes.medium.model, "openai-codex/gpt-6-sol");

		writeFileSync(join(dir, "unknown.json"), JSON.stringify({ modes: { low: { model: "fabel" } } }));
		assert.throws(
			() => loadDialConfig(extensionDir, [{ path: join(dir, "unknown.json"), required: true }]),
			/modes\.low\.model: unknown model alias "fabel"/,
		);

		writeFileSync(join(dir, "chained.json"), JSON.stringify({ models: { writer: "fable" } }));
		assert.throws(
			() => loadDialConfig(extensionDir, [{ path: join(dir, "chained.json"), required: true }]),
			/models\.writer: expected provider\/model/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
