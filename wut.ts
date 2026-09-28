/**
 * /wut — "what's going on?"
 *
 * Ask a cheap observer model (gpt-5.6-luna, or the session model when Luna is
 * unavailable or unauthenticated) to explain what the agent has been
 * doing since your last message, without interrupting it. The agent keeps
 * running underneath; the observer call is a completely separate model call.
 *
 * - /wut            → plain-language update in an overlay
 * - /wut <question> → ask the observer something specific
 * - In the overlay: type + Enter to ask a follow-up, empty Enter to refresh
 *   with the latest activity, Ctrl+O to copy the latest answer, PgUp/PgDn
 *   (or Alt+↑/↓) to scroll, Esc to close.
 *
 * Watchdog (auto-wut): once the agent has been working more than 15 minutes
 * since your last message, the observer periodically checks whether it is
 * spinning its wheels (same error over and over, repeating near-identical
 * actions). If clearly stuck it steers the agent with a prod message
 * (rate-limited, max a couple per task) and notifies you. The prod is a real
 * user-role message in the session transcript, so it can be audited later.
 * Toggle with /wut auto on | off.
 */

import { uuidv7, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { copyToClipboard, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const OBSERVER_PROVIDER = "openai-codex";
const OBSERVER_MODEL_ID = "gpt-5.6-luna";
const DEFAULT_QUESTION = "What's going on? Give me a quick update.";
const SYSTEM_PROMPT =
	"You are watching a coding agent work on behalf of its user. Explain what happened and what it is doing right now in plain language. Don't use the agent's jargon and speak coherently. State it simply and concisely, like one human talking to another.";

const MAX_TRANSCRIPT_CHARS = 100_000;
const MAX_GOAL_CHARS = 3_000;
const MAX_ASSISTANT_CHARS = 4_000;
const MAX_TOOL_ARG_CHARS = 600;
const MAX_TOOL_RESULT_CHARS = 1_500;
const MAX_PARTIAL_CHARS = 2_000;
const MAX_COMPACTION_CHARS = 2_000;
const MAX_SHOWN_EXCHANGES = 3;
const OVERLAY_HEIGHT_FRACTION = 0.85;
const SCROLL_STEP = 5;

// Watchdog (auto-wut) tuning.
const WATCHDOG_MIN_RUN_MS = 15 * 60_000; // agent must have worked this long since the user's last message
const WATCHDOG_TICK_MS = 30_000;
const WATCHDOG_CHECK_INTERVAL_MS = 3 * 60_000; // min gap between observer checks
const WATCHDOG_MIN_EVENTS = 3; // min tool events since last check
const WATCHDOG_LONG_TOOL_MS = 10 * 60_000; // …or a single tool running this long
const WATCHDOG_PROD_COOLDOWN_MS = 10 * 60_000;
const WATCHDOG_MAX_PRODS = 2; // per real user message
const WATCHDOG_PROD_PREFIX = "<wut_watchdog>";
const WATCHDOG_QUESTION = [
	"This is an automatic check, not the user asking.",
	"Judge whether the agent is genuinely stuck: repeating near-identical commands or edits, hitting the same error again and again, undoing and redoing the same change, or looping without getting closer to the goal.",
	"Slow, methodical progress is NOT stuck. A long-running build, test, or download is NOT stuck. Be conservative: only call it stuck with clear repeated evidence.",
	"If clearly stuck, reply exactly: STUCK: <one short sentence - what it keeps repeating and one concrete suggestion>",
	"Otherwise reply exactly: OK",
].join("\n");

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const clip = (text: string, max: number): string => {
	const trimmed = text.trim();
	if (trimmed.length <= max) return trimmed;
	const head = Math.ceil(max * 0.6);
	const tail = Math.floor(max * 0.4);
	const omitted = trimmed.length - head - tail;
	return `${trimmed.slice(0, head)}\n[… ${omitted} chars omitted …]\n${trimmed.slice(trimmed.length - tail)}`;
};

const clipTail = (text: string, max: number): string => {
	const trimmed = text.trim();
	if (trimmed.length <= max) return trimmed;
	return `[…] ${trimmed.slice(trimmed.length - max)}`;
};

type Block = {
	type?: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: unknown;
};

const blockText = (content: unknown, type: "text" | "thinking"): string => {
	if (typeof content === "string") return type === "text" ? content : "";
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const raw of content) {
		if (!raw || typeof raw !== "object") continue;
		const block = raw as Block;
		if (block.type !== type) continue;
		const value = type === "text" ? block.text : block.thinking;
		if (typeof value === "string" && value.trim().length > 0) parts.push(value);
	}
	return parts.join("\n");
};

const toolCallLines = (content: unknown): string[] => {
	if (!Array.isArray(content)) return [];
	const lines: string[] = [];
	for (const raw of content) {
		if (!raw || typeof raw !== "object") continue;
		const block = raw as Block;
		if (block.type !== "toolCall" || typeof block.name !== "string") continue;
		lines.push(`Agent ran tool ${block.name}: ${clip(JSON.stringify(block.arguments ?? {}), MAX_TOOL_ARG_CHARS)}`);
	}
	return lines;
};

// ---------------------------------------------------------------------------
// Activity transcript
// ---------------------------------------------------------------------------

type SessionEntryLike = {
	type: string;
	summary?: string;
	message?: {
		role?: string;
		content?: unknown;
		timestamp?: number;
		toolName?: string;
		isError?: boolean;
	};
};

interface LiveState {
	partialText: string;
	partialThinking: string;
	running: Map<string, { desc: string; startedAt: number }>;
}

/**
 * Synthetic user-role messages injected by extensions (e.g. pi-codex-goal's
 * auto-continuation nudges). These must not count as "the user's last message"
 * or the activity window would reset at every nudge. Prefix matching is the
 * fallback; the primary signal is the `input` event's source (see below),
 * which extension-injected messages never fire with source "interactive"/"rpc".
 */
const SYNTHETIC_USER_PREFIXES = ["<pi_goal_continuation ", WATCHDOG_PROD_PREFIX];

const isSyntheticUserMessage = (content: unknown): boolean => {
	const text = blockText(content, "text").trimStart();
	return SYNTHETIC_USER_PREFIXES.some((prefix) => text.startsWith(prefix));
};

const buildTranscript = (
	ctx: ExtensionContext,
	live: LiveState,
	lastRealInputAt?: number,
): string => {
	const entries = ctx.sessionManager.getBranch() as SessionEntryLike[];

	let lastUserIndex = -1;
	// Primary anchor: the session user entry created for the last input pi
	// received from a real source ("interactive"/"rpc", never "extension").
	if (lastRealInputAt !== undefined) {
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			if (
				entry.type === "message" &&
				entry.message?.role === "user" &&
				(entry.message.timestamp ?? 0) >= lastRealInputAt - 1_000 &&
				!isSyntheticUserMessage(entry.message.content)
			) {
				lastUserIndex = i;
				break;
			}
		}
	}
	// Fallback (no input observed yet, e.g. right after /reload or resume):
	// newest user entry that doesn't look extension-injected.
	if (lastUserIndex === -1) {
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (
				entry.type === "message" &&
				entry.message?.role === "user" &&
				!isSyntheticUserMessage(entry.message.content)
			) {
				lastUserIndex = i;
				break;
			}
		}
	}

	const sections: string[] = [];
	if (lastUserIndex >= 0) {
		const goal = blockText(entries[lastUserIndex].message?.content, "text");
		sections.push(`The user's last message (the goal):\n${clip(goal, MAX_GOAL_CHARS)}`);
	} else {
		sections.push("The user has not sent any message yet in this session.");
	}

	for (let i = lastUserIndex + 1; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type === "compaction" && entry.summary) {
			sections.push(
				`(the agent's context was compacted here - its own summary of everything before this point:\n${clip(entry.summary, MAX_COMPACTION_CHARS)})`,
			);
			continue;
		}
		if (entry.type !== "message" || !entry.message?.role) continue;
		const msg = entry.message;

		if (msg.role === "assistant") {
			const text = blockText(msg.content, "text");
			if (text) sections.push(`Agent said:\n${clip(text, MAX_ASSISTANT_CHARS)}`);
			sections.push(...toolCallLines(msg.content));
		} else if (msg.role === "toolResult") {
			const text = blockText(msg.content, "text");
			const status = msg.isError ? " (FAILED)" : "";
			sections.push(`Result of ${msg.toolName ?? "tool"}${status}:\n${clip(text || "(no output)", MAX_TOOL_RESULT_CHARS)}`);
		} else if (msg.role === "user") {
			// Only synthetic nudges can appear here (real ones are the anchor).
			const text = blockText(msg.content, "text").trimStart();
			sections.push(
				text.startsWith(WATCHDOG_PROD_PREFIX)
					? "(watchdog prod: the agent was warned it might be going in circles and told to reassess)"
					: "(automatic nudge: the agent was told to keep working toward its active long-running goal)",
			);
		}
	}

	// Keep the goal, drop the oldest activity if the transcript is too big.
	const total = () => sections.reduce((n, s) => n + s.length + 2, 0);
	let dropped = 0;
	while (sections.length > 2 && total() > MAX_TRANSCRIPT_CHARS) {
		sections.splice(1, 1);
		dropped++;
	}
	if (dropped > 0) sections.splice(1, 0, `[… ${dropped} earlier steps omitted …]`);

	// Live, in-flight state (not yet in the session).
	const liveLines: string[] = [];
	if (live.running.size > 0) {
		liveLines.push(
			`Tools running right now:\n${[...live.running.values()].map((t) => t.desc).join("\n")}`,
		);
	}
	if (live.partialText) {
		liveLines.push(`Agent's reply so far (still streaming):\n${clipTail(live.partialText, MAX_PARTIAL_CHARS)}`);
	} else if (live.partialThinking) {
		liveLines.push(`Agent's in-progress thinking (still streaming):\n${clipTail(live.partialThinking, MAX_PARTIAL_CHARS)}`);
	}
	if (liveLines.length > 0) {
		sections.push(`RIGHT NOW (in flight):\n${liveLines.join("\n\n")}`);
	} else if (ctx.isIdle()) {
		sections.push("The agent is currently idle - it has finished and is waiting for the user.");
	} else {
		sections.push("The agent is currently working (between steps).");
	}

	return sections.join("\n\n");
};

const firstPrompt = (transcript: string, question: string): string =>
	`Here is what the coding agent has been doing since the user's last message:\n\n<activity>\n${transcript}\n</activity>\n\n${question}`;

const makeUserMessage = (text: string): Message => ({
	role: "user",
	content: [{ type: "text", text }],
	timestamp: Date.now(),
});

// ---------------------------------------------------------------------------
// Observer model call
// ---------------------------------------------------------------------------

const observerModel = (ctx: ExtensionContext) => {
	const luna = ctx.modelRegistry.find(OBSERVER_PROVIDER, OBSERVER_MODEL_ID);
	return luna && ctx.modelRegistry.hasConfiguredAuth(luna) ? luna : ctx.model;
};

const askObserver = async (
	ctx: ExtensionContext,
	messages: Message[],
	sessionId: string,
	signal?: AbortSignal,
): Promise<AssistantMessage> => {
	const model = observerModel(ctx);
	if (!model) throw new Error("No observer model available");
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
		throw new Error(`No auth configured for ${model.provider}/${model.id}`);
	}
	return ctx.modelRegistry.complete(
		model,
		{ systemPrompt: SYSTEM_PROMPT, messages },
		{ reasoningEffort: "low", sessionId, signal },
	);
};

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const live: LiveState = { partialText: "", partialThinking: "", running: new Map() };
	let lastRealInputAt: number | undefined;

	// --- Watchdog (auto-wut) state ---
	let watchdogEnabled = true;
	let watchdogTimer: ReturnType<typeof setInterval> | undefined;
	let watchdogChecking = false;
	let lastCheckAt = 0;
	let toolEventsSinceCheck = 0;
	let lastStuckActionAt = 0;
	let prodsSinceRealInput = 0;
	let agentCtx: ExtensionContext | undefined;

	const handleStuck = (ctx: ExtensionContext, reason: string) => {
		if (Date.now() - lastStuckActionAt < WATCHDOG_PROD_COOLDOWN_MS) return;
		lastStuckActionAt = Date.now();
		if (prodsSinceRealInput < WATCHDOG_MAX_PRODS && !ctx.isIdle()) {
			prodsSinceRealInput++;
			pi.sendUserMessage(
				`${WATCHDOG_PROD_PREFIX} A friendly observer agent thinks you may be going in circles. It said: ${reason}\nPause, consider the user's intent, and consider whether you should take a step back and change approach, fix the source of current friction directly to enable progress, or stay the course. Then proceed with your chosen course of action.`,
				{ deliverAs: "steer" },
			);
			if (ctx.hasUI) ctx.ui.notify(`wut: prodded the agent - ${reason}`, "warning");
		} else if (ctx.hasUI) {
			ctx.ui.notify(`wut: agent still looks stuck (${reason}) - not prodding again, take a look`, "warning");
		}
	};

	const watchdogTick = async () => {
		const ctx = agentCtx;
		if (!watchdogEnabled || watchdogChecking || !ctx || ctx.isIdle()) return;
		// Only engage once the agent has been at it a while since the user's
		// last real message. (Undefined until an input is observed, e.g. after
		// /reload mid-run - the watchdog stays dormant until the next message.)
		if (lastRealInputAt === undefined || Date.now() - lastRealInputAt < WATCHDOG_MIN_RUN_MS) return;
		if (Date.now() - lastCheckAt < WATCHDOG_CHECK_INTERVAL_MS) return;
		const longTool = [...live.running.values()].some(
			(t) => Date.now() - t.startedAt > WATCHDOG_LONG_TOOL_MS,
		);
		if (toolEventsSinceCheck < WATCHDOG_MIN_EVENTS && !longTool) return;
		watchdogChecking = true;
		try {
			const transcript = buildTranscript(ctx, live, lastRealInputAt);
			const response = await askObserver(
				ctx,
				[makeUserMessage(firstPrompt(transcript, WATCHDOG_QUESTION))],
				uuidv7(),
			);
			const answer = blockText(response.content, "text").trim();
			if (/^STUCK\b/i.test(answer)) {
				const reason =
					answer.replace(/^STUCK[:\s]*/i, "").trim() ||
					"repeating the same actions without progress";
				handleStuck(ctx, reason);
			}
		} catch {
			// Watchdog is best-effort; never disturb the session on failure.
		} finally {
			watchdogChecking = false;
			lastCheckAt = Date.now();
			toolEventsSinceCheck = 0;
		}
	};

	// Extension commands (like /wut itself) are checked before this event and
	// skip it, so opening the overlay never moves the anchor.
	pi.on("input", async (event) => {
		if (event.source !== "extension") {
			lastRealInputAt = Date.now();
			prodsSinceRealInput = 0;
		}
	});

	pi.on("agent_start", async (_event, ctx) => {
		agentCtx = ctx;
		live.partialText = "";
		live.partialThinking = "";
		live.running.clear();
		lastCheckAt = Date.now(); // grace period before the first check
		toolEventsSinceCheck = 0;
		if (watchdogTimer) clearInterval(watchdogTimer);
		watchdogTimer = setInterval(() => void watchdogTick(), WATCHDOG_TICK_MS);
		watchdogTimer.unref?.();
	});

	pi.on("message_update", async (event) => {
		if (event.message.role !== "assistant") return;
		live.partialText = blockText(event.message.content, "text");
		live.partialThinking = blockText(event.message.content, "thinking");
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		live.partialText = "";
		live.partialThinking = "";
	});

	pi.on("tool_execution_start", async (event) => {
		live.running.set(event.toolCallId, {
			desc: `${event.toolName}: ${clip(JSON.stringify(event.args ?? {}), MAX_TOOL_ARG_CHARS)}`,
			startedAt: Date.now(),
		});
	});

	pi.on("tool_execution_end", async (event) => {
		live.running.delete(event.toolCallId);
		toolEventsSinceCheck++;
	});

	pi.on("agent_settled", async () => {
		live.partialText = "";
		live.partialThinking = "";
		live.running.clear();
		if (watchdogTimer) {
			clearInterval(watchdogTimer);
			watchdogTimer = undefined;
		}
	});

	const showOverlay = async (ctx: ExtensionCommandContext, initialQuestion: string) => {
		const mdTheme = getMarkdownTheme();
		const observerSessionId = uuidv7();

		await ctx.ui.custom<void>(
			(tui, theme, _kb, done) => {
				type Exchange = { question: string; answer?: string };
				const exchanges: Exchange[] = [];
				let convo: Message[] = [];
				let loading = false;
				let error: string | undefined;
				let cachedLines: string[] | undefined;
				let controller: AbortController | undefined;
				let copied = false;
				let copyTimer: ReturnType<typeof setTimeout> | undefined;
				let scrollUp = 0; // lines scrolled up from the bottom (0 = pinned to bottom)

				const editorTheme: EditorTheme = {
					borderColor: (s) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					},
				};
				const editor = new Editor(tui, editorTheme);

				const invalidate = () => {
					cachedLines = undefined;
					tui.requestRender();
				};

				const ask = (question: string, reset: boolean) => {
					if (loading) return;
					loading = true;
					error = undefined;
					scrollUp = 0;
					controller = new AbortController();
					if (reset) convo = [];
					if (convo.length === 0) {
						convo.push(
							makeUserMessage(firstPrompt(buildTranscript(ctx, live, lastRealInputAt), question)),
						);
					} else {
						convo.push(makeUserMessage(question));
					}
					exchanges.push({ question });
					invalidate();

					void (async () => {
						try {
							const response = await askObserver(ctx, convo, observerSessionId, controller?.signal);
							convo.push(response);
							exchanges[exchanges.length - 1].answer =
								blockText(response.content, "text") || "(no answer)";
						} catch (err) {
							if (!controller?.signal.aborted) {
								error = err instanceof Error ? err.message : String(err);
								exchanges.pop();
								convo.pop();
							}
						} finally {
							loading = false;
							scrollUp = 0;
							invalidate();
						}
					})();
				};

				editor.onSubmit = (value) => {
					if (loading) return;
					const question = value.trim();
					editor.setText("");
					if (question) {
						ask(question, false);
					} else {
						ask(DEFAULT_QUESTION, true); // refresh with the latest activity
					}
				};

				const render = (width: number): string[] => {
					if (cachedLines) return cachedLines;
					const w = Math.max(30, width);
					const inner = w - 4; // "│ " … " │"

					const content: string[] = [];
					const shown = exchanges.slice(-MAX_SHOWN_EXCHANGES);
					if (exchanges.length > shown.length) {
						content.push(theme.fg("dim", `(${exchanges.length - shown.length} earlier answers hidden)`));
					}
					for (const exchange of shown) {
						content.push("");
						content.push(...wrapTextWithAnsi(theme.fg("muted", `❯ ${exchange.question}`), inner));
						if (exchange.answer) {
							content.push(...new Markdown(exchange.answer, 1, 0, mdTheme).render(inner));
						}
					}

					if (loading) {
						content.push("");
						content.push(theme.fg("dim", "thinking…"));
					}
					if (error) {
						content.push("");
						content.push(...wrapTextWithAnsi(theme.fg("error", `Error: ${error}`), inner));
					}

					content.push("");
					content.push(...editor.render(inner));
					content.push(
						copied
							? theme.fg("success", "copied ✓")
							: theme.fg("dim", "Enter ask · empty Enter refresh · ^O copy · Esc close"),
					);

					// Viewport: pi clips overlays at maxHeight from the top, which would
					// hide the editor and latest answer. Window the content ourselves,
					// pinned to the bottom, scrollable with PgUp/PgDn.
					const termRows = process.stdout.rows ?? 40;
					const maxContent = Math.max(6, Math.floor(termRows * OVERLAY_HEIGHT_FRACTION) - 2);
					let visible = content;
					const overflow = Math.max(0, content.length - maxContent);
					if (scrollUp > overflow) scrollUp = overflow;
					if (overflow > 0) {
						const start = overflow - scrollUp;
						visible = content.slice(start, start + maxContent);
						if (start > 0) visible[0] = theme.fg("dim", `↑ ${start} more (PgUp)`);
						if (scrollUp > 0) visible[visible.length - 1] = theme.fg("dim", `↓ ${scrollUp} more (PgDn)`);
					}

					// Rounded frame with the title in the top border.
					const lines: string[] = [];
					const title = ` wut · ${observerModel(ctx)?.id ?? "no model"} `;
					const fill = Math.max(0, w - 3 - visibleWidth(title));
					lines.push(
						theme.fg("accent", "╭─") +
							theme.fg("accent", theme.bold(title)) +
							theme.fg("accent", `${"─".repeat(fill)}╮`),
					);
					const bar = theme.fg("accent", "│");
					for (const raw of visible) {
						const line = visibleWidth(raw) > inner ? truncateToWidth(raw, inner) : raw;
						const pad = " ".repeat(Math.max(0, inner - visibleWidth(line)));
						lines.push(`${bar} ${line}${pad} ${bar}`);
					}
					lines.push(theme.fg("accent", `╰${"─".repeat(w - 2)}╯`));

					cachedLines = lines;
					return lines;
				};

				// Kick off the first question immediately.
				ask(initialQuestion, true);

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
					},
					handleInput: (data: string) => {
						if (matchesKey(data, Key.escape)) {
							if (copyTimer) clearTimeout(copyTimer);
							controller?.abort();
							done(undefined);
							return;
						}
						if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.alt("up"))) {
							scrollUp += SCROLL_STEP;
							invalidate();
							return;
						}
						if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.alt("down"))) {
							scrollUp = Math.max(0, scrollUp - SCROLL_STEP);
							invalidate();
							return;
						}
						if (matchesKey(data, Key.ctrl("o"))) {
							const latest = [...exchanges].reverse().find((e) => e.answer);
							if (latest?.answer) {
								void copyToClipboard(latest.answer);
								copied = true;
								if (copyTimer) clearTimeout(copyTimer);
								copyTimer = setTimeout(() => {
									copied = false;
									invalidate();
								}, 1500);
								invalidate();
							}
							return;
						}
						editor.handleInput(data);
						invalidate();
					},
				};
			},
			{
				overlay: true,
				overlayOptions: {
					width: "75%",
					minWidth: 60,
					maxHeight: `${Math.round(OVERLAY_HEIGHT_FRACTION * 100)}%`,
					anchor: "center",
				},
			},
		);
	};

	pi.registerCommand("wut", {
		description:
			"Plain-language update on what the agent is doing; '/wut auto on|off' toggles the stuck-watchdog",
		handler: async (args, ctx) => {
			const trimmed = args?.trim() ?? "";

			if (/^auto\b/i.test(trimmed)) {
				const arg = trimmed.slice(4).trim().toLowerCase();
				if (arg === "on") watchdogEnabled = true;
				else if (arg === "off") watchdogEnabled = false;
				const status = watchdogEnabled
					? `wut watchdog ON - checks every ${WATCHDOG_CHECK_INTERVAL_MS / 60_000} min while the agent works, prods it (max ${WATCHDOG_MAX_PRODS} per task) when it looks stuck`
					: "wut watchdog OFF";
				if (ctx.hasUI) ctx.ui.notify(status, "info");
				else console.log(status);
				return;
			}

			const initialQuestion = trimmed ? trimmed : DEFAULT_QUESTION;

			if (ctx.mode !== "tui") {
				const convo = [
					makeUserMessage(firstPrompt(buildTranscript(ctx, live, lastRealInputAt), initialQuestion)),
				];
				const response = await askObserver(ctx, convo, uuidv7());
				const answer = blockText(response.content, "text") || "(no answer)";
				if (ctx.hasUI) {
					ctx.ui.notify(answer, "info");
				} else {
					console.log(answer);
				}
				return;
			}

			await showOverlay(ctx, initialQuestion);
		},
	});
}
