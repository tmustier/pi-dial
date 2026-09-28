import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type KeyId } from "@earendil-works/pi-tui";

export interface HudTheme {
	fg(color: ThemeColor, text: string): string;
	bold(text: string): string;
}

export interface HudMode {
	key: string;
	label: string;
	description: string;
	agent: string;
	oracle?: string;
	color: ThemeColor;
	unavailableReason?: string;
}

export type HudApplyOutcome =
	| { status: "applied" }
	| { status: "queued" }
	| { status: "failed"; error: string };

export interface DialHudOptions {
	detents: HudMode[];
	extras: HudMode[];
	activeKey?: string;
	shortcut: KeyId | false;
	autoCloseMs: number | false;
	theme: HudTheme;
	onApply(key: string): Promise<HudApplyOutcome> | HudApplyOutcome;
	onPassthroughText(text: string): void;
	requestRender(): void;
}

const MAX_BOX_WIDTH = 64;
const MAX_EXTRAS_ROWS = 8;
const FILL_CHAR = "\u2022";
const TRACK_CHAR = "\u00b7";

function isPrintableText(data: string): boolean {
	if (data.length === 0) return false;
	for (const char of data) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return false;
	}
	return true;
}

export class DialHud {
	private readonly options: DialHudOptions;
	private readonly done: () => void;
	private view: "dial" | "extras" = "dial";
	private cursorKey: string;
	private extrasCursor = 0;
	private appliedKey: string | undefined;
	private outcome: { key: string; result: HudApplyOutcome } | undefined;
	private applySeq = 0;
	private closed = false;
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(options: DialHudOptions, done: () => void) {
		this.options = options;
		this.done = done;
		this.appliedKey = options.activeKey;
		const active = options.detents.find((detent) => detent.key === options.activeKey);
		const middle = options.detents[Math.floor((options.detents.length - 1) / 2)];
		this.cursorKey = active?.key ?? middle?.key ?? "";
		const activeExtra = options.extras.findIndex((extra) => extra.key === options.activeKey);
		if (activeExtra >= 0) this.extrasCursor = activeExtra;
		this.resetTimer();
	}

	get isClosed(): boolean {
		return this.closed;
	}

	turnRight(): void {
		this.resetTimer();
		this.turn(1, true);
	}

	handleInput(data: string): void {
		if (this.closed) return;
		this.resetTimer();
		if (matchesKey(data, Key.escape)) {
			this.close();
			return;
		}
		if (this.options.shortcut !== false && matchesKey(data, this.options.shortcut)) {
			this.turn(1, true);
			return;
		}
		if (this.view === "dial") this.handleDialInput(data);
		else this.handleExtrasInput(data);
	}

	render(width: number): string[] {
		const boxWidth = Math.min(width, MAX_BOX_WIDTH);
		const inner = Math.max(10, boxWidth - 4);
		const lines = this.view === "dial" ? this.renderDial(inner) : this.renderExtras(inner);
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		this.done();
	}

	private resetTimer(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		if (this.options.autoCloseMs === false) return;
		this.timer = setTimeout(() => this.close(), this.options.autoCloseMs);
		this.timer.unref?.();
	}

	private handleDialInput(data: string): void {
		if (matchesKey(data, Key.enter)) {
			this.close();
			return;
		}
		if (matchesKey(data, Key.left)) {
			this.turn(-1, false);
			return;
		}
		if (matchesKey(data, Key.right)) {
			this.turn(1, false);
			return;
		}
		if (matchesKey(data, Key.tab) && this.options.extras.length > 0) {
			this.view = "extras";
			this.options.requestRender();
			return;
		}
		if (/^[1-9]$/.test(data)) {
			const index = Number.parseInt(data, 10) - 1;
			if (index < this.options.detents.length) {
				this.turnTo(index);
				return;
			}
		}
		this.passthrough(data);
	}

	private handleExtrasInput(data: string): void {
		const extras = this.options.extras;
		if (matchesKey(data, Key.tab)) {
			this.view = "dial";
			this.options.requestRender();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.extrasCursor = Math.max(0, this.extrasCursor - 1);
			this.options.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.extrasCursor = Math.min(extras.length - 1, this.extrasCursor + 1);
			this.options.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const extra = extras[this.extrasCursor];
			if (!extra) return;
			this.outcome = undefined;
			if (!extra.unavailableReason) this.fireApply(extra.key);
			this.options.requestRender();
			return;
		}
		this.passthrough(data);
	}

	private passthrough(data: string): void {
		if (!isPrintableText(data)) return;
		this.close();
		this.options.onPassthroughText(data);
	}

	private turn(delta: number, wrap: boolean): void {
		const detents = this.options.detents;
		if (detents.length === 0) return;
		const current = detents.findIndex((detent) => detent.key === this.cursorKey);
		let index = (current < 0 ? Math.floor((detents.length - 1) / 2) : current) + delta;
		if (wrap) index = ((index % detents.length) + detents.length) % detents.length;
		else index = Math.max(0, Math.min(detents.length - 1, index));
		this.turnTo(index);
	}

	private turnTo(index: number): void {
		const detent = this.options.detents[index];
		if (!detent) return;
		if (this.view !== "dial") this.view = "dial";
		this.cursorKey = detent.key;
		this.outcome = undefined;
		if (!detent.unavailableReason && detent.key !== this.appliedKey) this.fireApply(detent.key);
		this.options.requestRender();
	}

	private fireApply(key: string): void {
		const seq = ++this.applySeq;
		Promise.resolve()
			.then(() => this.options.onApply(key))
			.then((result) => {
				if (seq !== this.applySeq || this.closed) return;
				this.outcome = { key, result };
				if (result.status === "applied") this.appliedKey = key;
				this.options.requestRender();
			})
			.catch((error: unknown) => {
				if (seq !== this.applySeq || this.closed) return;
				this.outcome = {
					key,
					result: { status: "failed", error: error instanceof Error ? error.message : String(error) },
				};
				this.options.requestRender();
			});
	}

	private cursorDetent(): HudMode | undefined {
		return this.options.detents.find((detent) => detent.key === this.cursorKey);
	}

	private engagedExtra(): HudMode | undefined {
		return this.options.extras.find((extra) => extra.key === this.appliedKey);
	}

	private statusLine(subject: HudMode | undefined): string {
		const theme = this.options.theme;
		if (subject?.unavailableReason) {
			return theme.fg("warning", `unavailable \u2014 ${subject.unavailableReason}`);
		}
		if (this.outcome && this.outcome.key === subject?.key) {
			if (this.outcome.result.status === "queued") {
				return theme.fg("warning", "queued \u2014 applies when the current turn settles");
			}
			if (this.outcome.result.status === "failed") {
				return theme.fg("error", `failed \u2014 ${this.outcome.result.error}`);
			}
		}
		const engaged = this.engagedExtra();
		if (this.view === "dial" && engaged) {
			return theme.fg("accent", `${engaged.label} engaged \u2014 turn the dial to switch back`);
		}
		return "";
	}

	private frame(inner: number, title: string, hint: string, rows: string[]): string[] {
		const theme = this.options.theme;
		const border = (text: string): string => theme.fg("border", text);
		const titleText = ` ${title} `;
		const top =
			border("\u256d\u2500") +
			theme.fg("dim", titleText) +
			border("\u2500".repeat(Math.max(0, inner - visibleWidth(titleText))) + "\u2500\u256e");
		const hintText = ` ${hint} `;
		const bottom =
			border("\u2570" + "\u2500".repeat(Math.max(0, inner - visibleWidth(hintText) + 1))) +
			theme.fg("dim", hintText) +
			border("\u2500\u256f");
		const body = rows.map((row) => {
			const pad = Math.max(0, inner - visibleWidth(row));
			return border("\u2502 ") + row + " ".repeat(pad) + border(" \u2502");
		});
		return [top, ...body, bottom];
	}

	private renderDial(inner: number): string[] {
		const theme = this.options.theme;
		const detents = this.options.detents;
		const cursor = this.cursorDetent();
		const cursorIndex = detents.findIndex((detent) => detent.key === this.cursorKey);
		const engaged = this.engagedExtra();

		const track = inner;
		let fillLength = 0;
		if (!engaged && cursorIndex >= 0 && detents.length > 0) {
			fillLength =
				detents.length === 1
					? track
					: Math.max(1, Math.round((cursorIndex / (detents.length - 1)) * track));
		}
		const fillColor: ThemeColor = cursor?.unavailableReason ? "dim" : (cursor?.color ?? "accent");
		const gauge =
			theme.fg(fillColor, FILL_CHAR.repeat(fillLength)) +
			theme.fg("dim", TRACK_CHAR.repeat(Math.max(0, track - fillLength)));

		let labelRow = "";
		let column = 0;
		for (const [index, detent] of detents.entries()) {
			const label = detent.label.toLowerCase();
			const target =
				detents.length === 1 ? 0 : Math.round((index * (inner - label.length)) / (detents.length - 1));
			const start = Math.max(column, target);
			if (start + label.length > inner) break;
			labelRow += " ".repeat(start - column);
			const selected = index === cursorIndex && !engaged;
			let styled: string;
			if (detent.unavailableReason) styled = theme.fg("dim", label);
			else if (selected) styled = theme.bold(theme.fg(detent.color, label));
			else styled = theme.fg(detent.color, label);
			labelRow += styled;
			column = start + label.length;
		}

		const subject = engaged ?? cursor;
		const agentLine = theme.fg("muted", "Agent:  ") + (subject?.agent ?? "");
		const oracleLine = theme.fg("muted", "Oracle: ") + (subject?.oracle ?? theme.fg("dim", "off"));
		const description = theme.fg("muted", subject?.description ?? "");

		const hints = ["\u2190\u2192 turn"];
		if (detents.length > 1) hints.push(`1-${Math.min(9, detents.length)} jump`);
		if (this.options.extras.length > 0) hints.push("tab extras");
		hints.push("esc");
		return this.frame(inner, "Pi dial", hints.join(" \u00b7 "), [
			gauge,
			labelRow,
			"",
			agentLine,
			oracleLine,
			"",
			description,
			this.statusLine(subject),
		]);
	}

	private renderExtras(inner: number): string[] {
		const theme = this.options.theme;
		const extras = this.options.extras;
		const windowStart = Math.max(
			0,
			Math.min(this.extrasCursor - MAX_EXTRAS_ROWS + 1, extras.length - MAX_EXTRAS_ROWS),
		);
		const visible = extras.slice(windowStart, windowStart + MAX_EXTRAS_ROWS);
		const rows = visible.map((extra, offset) => {
			const index = windowStart + offset;
			const selected = index === this.extrasCursor;
			const marker = selected ? theme.fg("accent", "\u2023 ") : "  ";
			const applied = extra.key === this.appliedKey ? theme.fg(extra.color, " \u25cf") : "";
			let label: string;
			if (extra.unavailableReason) label = theme.fg("dim", extra.label);
			else if (selected) label = theme.bold(theme.fg(extra.color, extra.label));
			else label = theme.fg(extra.color, extra.label);
			const used = 2 + extra.label.length + (extra.key === this.appliedKey ? 2 : 0);
			const description = truncateToWidth(extra.description, Math.max(0, inner - used - 2));
			return `${marker}${label}${applied}  ${theme.fg("dim", description)}`;
		});
		if (extras.length > MAX_EXTRAS_ROWS) {
			rows.push(theme.fg("dim", `${this.extrasCursor + 1}/${extras.length}`));
		}
		const subject = extras[this.extrasCursor];
		rows.push(this.statusLine(subject));
		return this.frame(
			inner,
			"Pi dial \u00b7 extras",
			"\u2191\u2193 choose \u00b7 enter engage \u00b7 tab dial \u00b7 esc",
			rows,
		);
	}
}
