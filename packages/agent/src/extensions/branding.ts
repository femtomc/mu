/**
 * mu-branding — Custom serve-mode TUI chrome for mu.
 *
 * Defaults to a minimal, information-dense layout:
 * - Compact header + footer
 * - Terminal title and working message branding
 * - Lightweight periodic status refresh (open/ready/control-plane)
 */

import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { MU_DEFAULT_THEME_NAME, MU_VERSION } from "../ui_defaults.js";
import { registerMuSubcommand } from "./mu-command-dispatcher.js";
import { fetchMuStatus, type MuControlPlaneRoute, muServerUrl } from "./shared.js";

type StatusSnapshot = {
	openCount: number;
	readyCount: number;
	controlPlaneActive: boolean;
	adapters: string[];
	error: string | null;
};

const EMPTY_SNAPSHOT: StatusSnapshot = {
	openCount: 0,
	readyCount: 0,
	controlPlaneActive: false,
	adapters: [],
	error: null,
};

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function visibleWidth(text: string): number {
	return text.replace(ANSI_RE, "").length;
}

function truncateToWidth(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	const plain = text.replace(ANSI_RE, "");
	if (width === 1) return plain.slice(0, 1);
	return `${plain.slice(0, width - 1)}…`;
}

function centerLine(text: string, width: number): string {
	const vw = visibleWidth(text);
	if (vw >= width) return truncateToWidth(text, width);
	const pad = Math.floor((width - vw) / 2);
	return " ".repeat(pad) + text;
}

function routesFromStatus(adapters: string[], routes: MuControlPlaneRoute[] | undefined): MuControlPlaneRoute[] {
	if (routes && routes.length > 0) return routes;
	return adapters.map((name) => ({ name, route: `/webhooks/${name}` }));
}

function shortModelLabel(ctx: ExtensionContext): string {
	if (!ctx.model) return "?";
	return ctx.model.id;
}

function shortModelLabelFromEvent(model: { id: string }): string {
	return model.id;
}

const BAR_CHARS = ["░", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];

function contextBar(percent: number, barWidth: number): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = (clamped / 100) * barWidth;
	const full = Math.floor(filled);
	const frac = filled - full;
	const fracIdx = Math.round(frac * (BAR_CHARS.length - 1));
	const empty = barWidth - full - (fracIdx > 0 ? 1 : 0);
	return (
		BAR_CHARS[BAR_CHARS.length - 1].repeat(full) +
		(fracIdx > 0 ? BAR_CHARS[fracIdx] : "") +
		BAR_CHARS[0].repeat(Math.max(0, empty))
	);
}

export function brandingExtension(pi: ExtensionAPI) {
	let enabled = true;
	let repoName = "mu";
	let currentModelLabel = "?";
	let snapshot: StatusSnapshot = { ...EMPTY_SNAPSHOT };
	let activeCtx: ExtensionContext | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let footerRequestRender: (() => void) | null = null;

	function applyDefaultTheme(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const result = ctx.ui.setTheme(MU_DEFAULT_THEME_NAME);
		if (!result.success) {
			ctx.ui.notify(`failed to apply ${MU_DEFAULT_THEME_NAME}: ${result.error ?? "unknown error"}`, "warning");
		}
	}

	function applyChrome(ctx: ExtensionContext): void {
		if (!ctx.hasUI || !enabled) return;

		ctx.ui.setTitle(`mu · ${repoName}`);
		ctx.ui.setWorkingMessage("working…");
		ctx.ui.setWidget("mu-quick-actions", undefined);

		ctx.ui.setHeader((_tui, theme) => ({
			render(width: number): string[] {
				const cpPart = snapshot.error
					? ""
					: snapshot.controlPlaneActive
						? ` ${theme.fg("muted", "·")} ${theme.fg("success", `cp:${snapshot.adapters.join(",") || "on"}`)}`
						: "";
				const line = [
					theme.fg("accent", theme.bold("μ")),
					theme.fg("muted", "·"),
					theme.fg("dim", `v${MU_VERSION}`),
					theme.fg("muted", "·"),
					theme.fg("dim", repoName),
				].join(" ") + cpPart;
				return [centerLine(line, width)];
			},
			invalidate() {},
		}));

		ctx.ui.setFooter((tui, theme, footerData) => {
			const requestRender = () => tui.requestRender();
			const unsubscribeBranch = footerData.onBranchChange(requestRender);
			footerRequestRender = requestRender;
			return {
				dispose() {
					if (footerRequestRender === requestRender) {
						footerRequestRender = null;
					}
					unsubscribeBranch();
				},
				invalidate() {},
				render(width: number): string[] {
					const parts: string[] = [theme.fg("dim", currentModelLabel)];

					const branch = footerData.getGitBranch();
					if (branch) {
						parts.push(theme.fg("muted", "·"), theme.fg("dim", branch));
					}

					const usage = activeCtx?.getContextUsage();
					if (usage && usage.percent != null) {
						const pct = Math.round(usage.percent);
						const barColor = pct >= 80 ? "warning" : pct >= 60 ? "muted" : "dim";
						parts.push(
							theme.fg("muted", "·"),
							theme.fg(barColor, `ctx ${pct}%`),
							theme.fg(barColor, contextBar(pct, 10)),
						);
					}

					if (snapshot.openCount > 0 || snapshot.readyCount > 0) {
						parts.push(
							theme.fg("muted", "·"),
							theme.fg("dim", `open ${snapshot.openCount} ready ${snapshot.readyCount}`),
						);
					}

					return [centerLine(parts.join(" "), width)];
				},
			};
		});
	}

	function clearChrome(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setHeader(undefined);
		ctx.ui.setFooter(undefined);
		ctx.ui.setWidget("mu-quick-actions", undefined);
		ctx.ui.setWorkingMessage();
		ctx.ui.setStatus("mu-overview", undefined);
	}

	async function refreshStatus(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI || !enabled) return;
		if (!muServerUrl()) {
			snapshot = {
				...EMPTY_SNAPSHOT,
				error: "MU_SERVER_URL not set",
			};
			ctx.ui.setStatus("mu-overview", ctx.ui.theme.fg("warning", "μ server unavailable"));
			footerRequestRender?.();
			return;
		}

		try {
			const status = await fetchMuStatus(4_000);
			const cp = status.control_plane ?? {
				active: false,
				adapters: [] as string[],
				routes: [] as MuControlPlaneRoute[],
			};
			snapshot = {
				openCount: status.open_count,
				readyCount: status.ready_count,
				controlPlaneActive: cp.active,
				adapters: routesFromStatus(cp.adapters, cp.routes).map((entry) => entry.name),
				error: null,
			};
			ctx.ui.setStatus(
				"mu-overview",
				ctx.ui.theme.fg(
					"dim",
					`μ open ${snapshot.openCount} · ready ${snapshot.readyCount} · cp ${snapshot.controlPlaneActive ? "on" : "off"}`,
				),
			);
		} catch (err) {
			snapshot = {
				...EMPTY_SNAPSHOT,
				error: err instanceof Error ? err.message : String(err),
			};
			ctx.ui.setStatus("mu-overview", ctx.ui.theme.fg("warning", "μ status refresh failed"));
		}

		footerRequestRender?.();
	}

	function ensurePolling() {
		if (pollTimer) return;
		pollTimer = setInterval(() => {
			if (!activeCtx) return;
			void refreshStatus(activeCtx);
		}, 12_000);
	}

	function stopPolling() {
		if (!pollTimer) return;
		clearInterval(pollTimer);
		pollTimer = null;
	}

	async function initialize(ctx: ExtensionContext): Promise<void> {
		activeCtx = ctx;
		repoName = basename(ctx.cwd);
		currentModelLabel = shortModelLabel(ctx);
		if (!ctx.hasUI) return;
		if (enabled) {
			applyDefaultTheme(ctx);
			applyChrome(ctx);
			await refreshStatus(ctx);
			ensurePolling();
		} else {
			clearChrome(ctx);
			stopPolling();
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		await initialize(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		await initialize(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		currentModelLabel = shortModelLabelFromEvent(event.model);
		if (!ctx.hasUI || !enabled) return;
		footerRequestRender?.();
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!ctx.hasUI || !enabled) return;
		footerRequestRender?.();
	});

	pi.on("session_shutdown", async () => {
		stopPolling();
		footerRequestRender = null;
		activeCtx = null;
	});

	registerMuSubcommand(pi, {
		subcommand: "brand",
		summary: "Toggle mu TUI branding",
		usage: "/mu brand [on|off|toggle]",
		handler: async (args, ctx) => {
			const mode = args.trim().toLowerCase();
			if (mode === "on") {
				enabled = true;
			} else if (mode === "off") {
				enabled = false;
			} else {
				enabled = !enabled;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify(`mu branding ${enabled ? "enabled" : "disabled"}.`, "info");
				return;
			}

			if (enabled) {
				applyDefaultTheme(ctx);
				applyChrome(ctx);
				await refreshStatus(ctx);
				ensurePolling();
			} else {
				clearChrome(ctx);
				stopPolling();
			}

			ctx.ui.notify(`mu branding ${enabled ? "enabled" : "disabled"}.`, "info");
		},
	});
}

export default brandingExtension;
