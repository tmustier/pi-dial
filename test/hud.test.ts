import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DialHud, type DialHudOptions, type HudApplyOutcome, type HudMode } from "../hud.ts";

const identityTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
} as DialHudOptions["theme"];

function mode(key: string, overrides: Partial<HudMode> = {}): HudMode {
	return {
		key,
		label: key,
		description: `${key} description`,
		agent: `provider/${key}-model (medium)`,
		oracle: `provider/${key}-oracle (high)`,
		color: "accent",
		...overrides,
	};
}

interface HudHarness {
	hud: DialHud;
	applied: string[];
	passthrough: string[];
	closed: () => boolean;
	rendered: () => string;
}

function createHud(options: {
	detents?: HudMode[];
	extras?: HudMode[];
	activeKey?: string;
	autoCloseMs?: number | false;
	outcome?: (key: string) => HudApplyOutcome;
}): HudHarness {
	const applied: string[] = [];
	const passthrough: string[] = [];
	let closed = false;
	const hud = new DialHud(
		{
			detents: options.detents ?? [mode("low"), mode("medium"), mode("high"), mode("ultra")],
			extras: options.extras ?? [],
			activeKey: options.activeKey,
			shortcut: "ctrl+shift+u",
			autoCloseMs: options.autoCloseMs ?? false,
			theme: identityTheme,
			onApply: (key) => {
				applied.push(key);
				return options.outcome ? options.outcome(key) : { status: "applied" };
			},
			onPassthroughText: (text) => passthrough.push(text),
			requestRender: () => {},
		},
		() => {
			closed = true;
		},
	);
	return {
		hud,
		applied,
		passthrough,
		closed: () => closed,
		rendered: () => hud.render(64).join("\n"),
	};
}

const RIGHT = "\u001b[C";
const LEFT = "\u001b[D";
const UP = "\u001b[A";
const DOWN = "\u001b[B";
const TAB = "\t";
const ENTER = "\r";
const ESCAPE = "\u001b";

test("gauge geometry: labels present, fill grows with the detent, and lines fit", async () => {
	const harness = createHud({ activeKey: "low" });
	const width = 64;
	const measure = () => {
		const lines = harness.hud.render(width);
		assert.equal(lines.length, 10);
		for (const line of lines) assert.equal(visibleWidth(line), width);
		const gauge = lines[1];
		return (gauge.match(/\u2022/g) ?? []).length;
	};
	const lowFill = measure();
	assert.equal(lowFill, 1);
	assert.match(harness.rendered(), /low.*medium.*high.*ultra/s);
	assert.match(harness.rendered(), /\u001b\[1mlow/);
	assert.match(harness.rendered(), /Agent: {2}provider\/low-model \(medium\)/);
	assert.match(harness.rendered(), /Oracle: provider\/low-oracle \(high\)/);
	assert.match(harness.rendered(), /low description/);

	harness.hud.handleInput(RIGHT);
	await delay(1);
	const mediumFill = measure();
	harness.hud.handleInput(RIGHT);
	harness.hud.handleInput(RIGHT);
	await delay(1);
	const ultraFill = measure();
	assert.ok(mediumFill > lowFill);
	assert.equal(ultraFill, 60);
	assert.deepEqual(harness.applied, ["medium", "high", "ultra"]);
});

test("arrows clamp at the ends and digits jump straight to a detent", async () => {
	const harness = createHud({ activeKey: "low" });
	harness.hud.handleInput(LEFT);
	assert.deepEqual(harness.applied, []);
	harness.hud.handleInput("4");
	await delay(1);
	assert.deepEqual(harness.applied, ["ultra"]);
	harness.hud.handleInput(RIGHT);
	assert.deepEqual(harness.applied, ["ultra"]);
});

test("the configured shortcut wraps around while open", async () => {
	const harness = createHud({ activeKey: "ultra" });
	harness.hud.turnRight();
	await delay(1);
	assert.deepEqual(harness.applied, ["low"]);
});

test("unavailable detents show the reason and are never applied", async () => {
	const harness = createHud({
		detents: [mode("low", { unavailableReason: "no authenticated model candidate" }), mode("medium"), mode("high")],
		activeKey: "medium",
	});
	harness.hud.handleInput(LEFT);
	await delay(1);
	assert.deepEqual(harness.applied, []);
	assert.match(harness.rendered(), /unavailable \u2014 no authenticated model candidate/);
});

test("queued and failed outcomes render their status", async () => {
	const queued = createHud({ activeKey: "low", outcome: () => ({ status: "queued" }) });
	queued.hud.handleInput(RIGHT);
	await delay(1);
	assert.match(queued.rendered(), /queued \u2014 applies when the current turn settles/);

	const failed = createHud({ activeKey: "low", outcome: () => ({ status: "failed", error: "boom" }) });
	failed.hud.handleInput(RIGHT);
	await delay(1);
	assert.match(failed.rendered(), /failed \u2014 boom/);
});

test("tab switches to extras where enter engages and the dial shows the engaged notice", async () => {
	const harness = createHud({
		extras: [mode("scout"), mode("archivist")],
		activeKey: "medium",
	});
	harness.hud.handleInput(TAB);
	assert.match(harness.rendered(), /Pi dial \u00b7 extras/);
	assert.match(harness.rendered(), /scout description/);
	harness.hud.handleInput(DOWN);
	harness.hud.handleInput(ENTER);
	await delay(1);
	assert.deepEqual(harness.applied, ["archivist"]);
	harness.hud.handleInput(UP);
	harness.hud.handleInput(TAB);
	assert.match(harness.rendered(), /archivist engaged \u2014 turn the dial to switch back/);
	harness.hud.handleInput(RIGHT);
	await delay(1);
	assert.deepEqual(harness.applied, ["archivist", "high"]);
	assert.ok(!harness.rendered().includes("engaged"));
});

test("escape closes, printable text falls through to the editor, and auto-close fires", async () => {
	const escape = createHud({ activeKey: "medium" });
	escape.hud.handleInput(ESCAPE);
	assert.ok(escape.closed());

	const typed = createHud({ activeKey: "medium" });
	typed.hud.handleInput("x");
	assert.deepEqual(typed.passthrough, ["x"]);
	assert.ok(typed.closed());
	assert.deepEqual(typed.applied, []);

	const auto = createHud({ activeKey: "medium", autoCloseMs: 20 });
	assert.ok(!auto.closed());
	await delay(60);
	assert.ok(auto.closed());
});
