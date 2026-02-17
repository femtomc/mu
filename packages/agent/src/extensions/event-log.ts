/**
 * mu-event-log — Event stream helper for mu serve.
 *
 * - Status line with last event type and tail count
 * - Optional watch widget below editor (`/mu events watch on|off`)
 * - Command for quick tail inspection (`/mu events [n]` or `/mu events tail [n]`)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { registerMuSubcommand } from "./mu-command-dispatcher.js";
import { clampInt, fetchMuJson, muServerUrl } from "./shared.js";

type EventEnvelope = {
	v: number;
	ts_ms: number;
	type: string;
	source: string;
	payload: Record<string, unknown>;
	run_id?: string;
	issue_id?: string;
};

function eventTime(tsMs: number): string {
	return new Date(tsMs).toLocaleTimeString();
}

function formatEventLine(event: EventEnvelope): string {
	const ts = eventTime(event.ts_ms);
	const payloadHint = event.issue_id ? ` issue:${event.issue_id}` : "";
	return `${ts}  ${event.type}  (${event.source})${payloadHint}`;
}

async function fetchTail(n: number): Promise<EventEnvelope[]> {
	if (!muServerUrl()) return [];
	try {
		return await fetchMuJson<EventEnvelope[]>(`/api/events/tail?n=${n}`, { timeoutMs: 6_000 });
	} catch {
		return [];
	}
}

export function eventLogExtension(pi: ExtensionAPI) {
	let watchEnabled = false;
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let activeCtx: ExtensionContext | null = null;

	async function refresh(ctx: ExtensionContext, opts: { tail?: number } = {}) {
		if (!ctx.hasUI) return;
		const tail = clampInt(opts.tail, 8, 1, 50);
		const events = await fetchTail(tail);
		if (events.length === 0) {
			ctx.ui.setStatus("mu-events", ctx.ui.theme.fg("dim", "events: none"));
			if (watchEnabled) {
				ctx.ui.setWidget("mu-events", [ctx.ui.theme.fg("dim", "(no events yet)")], { placement: "belowEditor" });
			}
			return;
		}

		const last = events[events.length - 1]!;
		ctx.ui.setStatus("mu-events", ctx.ui.theme.fg("dim", `events: ${events.length} · last ${last.type}`));

		if (watchEnabled) {
			const lines = events.slice(-5).map((event) => `  ${formatEventLine(event)}`);
			ctx.ui.setWidget("mu-events", lines, { placement: "belowEditor" });
		}
	}

	function stopPolling() {
		if (!pollTimer) return;
		clearInterval(pollTimer);
		pollTimer = null;
	}

	function ensurePolling() {
		if (pollTimer) return;
		pollTimer = setInterval(() => {
			if (!activeCtx) return;
			void refresh(activeCtx);
		}, 8_000);
	}

	function setWatchEnabled(next: boolean) {
		watchEnabled = next;
		if (watchEnabled) {
			ensurePolling();
			if (activeCtx) {
				void refresh(activeCtx);
			}
			return;
		}
		if (activeCtx?.hasUI) {
			activeCtx.ui.setWidget("mu-events", undefined);
		}
		stopPolling();
	}

	pi.on("session_start", async (_event, ctx) => {
		activeCtx = ctx;
		if (!ctx.hasUI) return;
		await refresh(ctx);
		if (watchEnabled) ensurePolling();
	});

	pi.on("session_switch", async (_event, ctx) => {
		activeCtx = ctx;
		if (!ctx.hasUI) return;
		await refresh(ctx);
		if (watchEnabled) ensurePolling();
	});

	pi.on("session_shutdown", async () => {
		stopPolling();
		activeCtx = null;
	});

	registerMuSubcommand(pi, {
		subcommand: "events",
		summary: "Inspect event tails and toggle the watch widget",
		usage: "/mu events [n] | /mu events tail [n] | /mu events watch on|off",
		handler: async (args, ctx) => {
			const tokens = args
				.trim()
				.split(/\s+/)
				.filter((token) => token.length > 0);

			if (tokens[0] === "watch") {
				const mode = (tokens[1] ?? "toggle").toLowerCase();
				if (mode === "on") {
					setWatchEnabled(true);
					ctx.ui.notify("Event watch enabled.", "info");
					return;
				}
				if (mode === "off") {
					setWatchEnabled(false);
					ctx.ui.notify("Event watch disabled.", "info");
					return;
				}
				setWatchEnabled(!watchEnabled);
				ctx.ui.notify(`Event watch ${watchEnabled ? "enabled" : "disabled"}.`, "info");
				return;
			}

			const requestedLimit =
				tokens[0] === "tail" ? Number.parseInt(tokens[1] ?? "20", 10) : Number.parseInt(tokens[0] ?? "20", 10);
			const limit = clampInt(Number.isFinite(requestedLimit) ? requestedLimit : undefined, 20, 1, 100);
			const events = await fetchTail(limit);
			if (events.length === 0) {
				ctx.ui.notify("No events found.", "info");
				return;
			}

			const lines = events.map((event) => formatEventLine(event));
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

export default eventLogExtension;
