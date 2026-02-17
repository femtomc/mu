/**
 * mu-branding — Custom serve-mode TUI chrome for mu.
 *
 * Adds:
 * - Custom header + footer
 * - Quick command widget above the editor
 * - Terminal title and working message branding
 * - Lightweight periodic status refresh (open/ready/control-plane)
 */

import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
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

const ANSI_RE = /\u001b\[[0-9;]*m/g;

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

function routesFromStatus(adapters: string[], routes: MuControlPlaneRoute[] | undefined): MuControlPlaneRoute[] {
	if (routes && routes.length > 0) return routes;
	return adapters.map((name) => ({ name, route: `/webhooks/${name}` }));
}

function modelLabelFromContext(ctx: ExtensionContext): string {
	if (!ctx.model) return "model:unknown";
	return `${ctx.model.provider}/${ctx.model.id}`;
}

function modelLabelFromEventModel(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

export function brandingExtension(pi: ExtensionAPI) {
	let enabled = true;
	let repoName = "mu";
	let currentModel = "model:unknown";
	let snapshot: StatusSnapshot = { ...EMPTY_SNAPSHOT };
	let activeCtx: ExtensionContext | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let footerRequestRender: (() => void) | null = null;

	function refreshWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget("mu-quick-actions", (_tui, theme) => ({
			render(width: number): string[] {
				const cpState = snapshot.error
					? theme.fg("warning", "cp unavailable")
					: snapshot.controlPlaneActive
						? theme.fg("success", `cp ${snapshot.adapters.join(",") || "on"}`)
						: theme.fg("muted", "cp off");
				const line1 = `${theme.fg("accent", "μ")}${theme.fg("dim", " quick actions")}: ${theme.fg("muted", "/mu status  /mu control  /mu setup  /mu events")}`;
				const line2 = `${theme.fg("dim", `open ${snapshot.openCount} · ready ${snapshot.readyCount}`)} · ${cpState}`;
				return [truncateToWidth(line1, width), truncateToWidth(line2, width)];
			},
			invalidate() {},
		}));
	}

	function applyChrome(ctx: ExtensionContext): void {
		if (!ctx.hasUI || !enabled) return;

		ctx.ui.setTitle(`mu • ${repoName}`);
		ctx.ui.setWorkingMessage("μ working...");

		ctx.ui.setHeader((_tui, theme) => ({
			render(width: number): string[] {
				const line1 = `${theme.fg("accent", theme.bold("μ"))} ${theme.bold("mu")} ${theme.fg("muted", "serve console")}`;
				const line2 = theme.fg("dim", `repo: ${repoName}`);
				const line3 = theme.fg("muted", "status via: mu_status · mu_control_plane · mu_messaging_setup");
				return [
					"",
					truncateToWidth(line1, width),
					truncateToWidth(line2, width),
					truncateToWidth(line3, width),
					"",
				];
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
					const cpLabel = snapshot.error
						? theme.fg("warning", "cp:unavailable")
						: snapshot.controlPlaneActive
							? theme.fg("success", `cp:${snapshot.adapters.join(",") || "on"}`)
							: theme.fg("muted", "cp:off");
					const left = [
						theme.fg("accent", "μ"),
						theme.fg("dim", repoName),
						theme.fg("muted", "|"),
						theme.fg("dim", `open ${snapshot.openCount} ready ${snapshot.readyCount}`),
						theme.fg("muted", "|"),
						cpLabel,
					].join(" ");

					const branch = footerData.getGitBranch();
					const right = theme.fg("dim", branch ? `${currentModel} · branch:${branch}` : currentModel);
					const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
					return [truncateToWidth(`${left}${pad}${right}`, width)];
				},
			};
		});

		refreshWidget(ctx);
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
			refreshWidget(ctx);
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

		refreshWidget(ctx);
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
		currentModel = modelLabelFromContext(ctx);
		if (!ctx.hasUI) return;
		if (enabled) {
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
		currentModel = modelLabelFromEventModel(event.model);
		if (!ctx.hasUI || !enabled) return;
		ctx.ui.setStatus("mu-model", ctx.ui.theme.fg("dim", currentModel));
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
