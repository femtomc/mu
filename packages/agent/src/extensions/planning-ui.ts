import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { registerMuSubcommand } from "./mu-command-dispatcher.js";

type PlanningPhase = "investigating" | "drafting" | "reviewing" | "approved";

type PlanningUiState = {
	enabled: boolean;
	phase: PlanningPhase;
	rootIssueId: string | null;
	steps: Array<{ label: string; done: boolean }>;
};

type PlanningToolAction =
	| "status"
	| "on"
	| "off"
	| "toggle"
	| "reset"
	| "phase"
	| "root"
	| "check"
	| "uncheck"
	| "toggle_step";

type PlanningToolParams = {
	action: PlanningToolAction;
	phase?: string;
	root_issue_id?: string;
	step?: number;
};

const DEFAULT_STEPS = [
	"Investigate relevant code/docs/state",
	"Create root issue + decomposed child issues",
	"Present plan with IDs, ordering, risks",
	"Refine with user feedback until approved",
] as const;

const BAR_CHARS = ["░", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"] as const;

function phaseTone(phase: PlanningPhase): "dim" | "accent" | "warning" | "success" {
	switch (phase) {
		case "investigating":
			return "dim";
		case "drafting":
			return "accent";
		case "reviewing":
			return "warning";
		case "approved":
			return "success";
	}
}

function progressBar(done: number, total: number, width = 10): string {
	if (width <= 0 || total <= 0) {
		return "";
	}
	const clampedDone = Math.max(0, Math.min(total, done));
	const filled = (clampedDone / total) * width;
	const full = Math.floor(filled);
	const frac = filled - full;
	const fracIdx = Math.round(frac * (BAR_CHARS.length - 1));
	const empty = width - full - (fracIdx > 0 ? 1 : 0);
	return (
		BAR_CHARS[BAR_CHARS.length - 1].repeat(full) +
		(fracIdx > 0 ? BAR_CHARS[fracIdx] : "") +
		BAR_CHARS[0].repeat(Math.max(0, empty))
	);
}

function createDefaultState(): PlanningUiState {
	return {
		enabled: false,
		phase: "investigating",
		rootIssueId: null,
		steps: DEFAULT_STEPS.map((label) => ({ label, done: false })),
	};
}

function summarizePhase(phase: PlanningPhase): string {
	switch (phase) {
		case "investigating":
			return "investigating";
		case "drafting":
			return "drafting";
		case "reviewing":
			return "reviewing";
		case "approved":
			return "approved";
	}
}

function renderPlanningUi(ctx: ExtensionContext, state: PlanningUiState): void {
	if (!ctx.hasUI) {
		return;
	}
	if (!state.enabled) {
		ctx.ui.setStatus("mu-planning", undefined);
		ctx.ui.setWidget("mu-planning", undefined);
		return;
	}

	const done = state.steps.filter((step) => step.done).length;
	const total = state.steps.length;
	const phase = summarizePhase(state.phase);
	const phaseColor = phaseTone(state.phase);
	const rootLabel = state.rootIssueId ?? "(unset)";
	const meter = progressBar(done, total, 10);

	ctx.ui.setStatus(
		"mu-planning",
		[
			ctx.ui.theme.fg("dim", "plan"),
			ctx.ui.theme.fg(phaseColor, phase),
			ctx.ui.theme.fg("dim", `${done}/${total}`),
			ctx.ui.theme.fg(phaseColor, meter),
			ctx.ui.theme.fg("muted", `root:${rootLabel}`),
		].join(` ${ctx.ui.theme.fg("muted", "·")} `),
	);

	const lines = [
		ctx.ui.theme.fg("accent", ctx.ui.theme.bold("Planning board")),
		`  ${ctx.ui.theme.fg("muted", "phase:")} ${ctx.ui.theme.fg(phaseColor, phase)}`,
		`  ${ctx.ui.theme.fg("muted", "progress:")} ${ctx.ui.theme.fg("dim", `${done}/${total}`)} ${ctx.ui.theme.fg(phaseColor, meter)}`,
		`  ${ctx.ui.theme.fg("muted", "root:")} ${ctx.ui.theme.fg("dim", rootLabel)}`,
		`  ${ctx.ui.theme.fg("dim", "────────────────────────────")}`,
		...state.steps.map((step, index) => {
			const mark = step.done ? ctx.ui.theme.fg("success", "☑") : ctx.ui.theme.fg("muted", "☐");
			const label = step.done ? ctx.ui.theme.fg("dim", step.label) : ctx.ui.theme.fg("text", step.label);
			return `${mark} ${ctx.ui.theme.fg("muted", `${index + 1}.`)} ${label}`;
		}),
		ctx.ui.theme.fg("muted", "  /mu plan status · /mu plan phase <...>"),
	];
	ctx.ui.setWidget("mu-planning", lines, { placement: "belowEditor" });
}

function planningUsageText(): string {
	return [
		"Usage:",
		"  /mu plan on|off|toggle|status|reset",
		"  /mu plan phase <investigating|drafting|reviewing|approved>",
		"  /mu plan root <issue-id|clear>",
		"  /mu plan check <n> | /mu plan uncheck <n> | /mu plan toggle-step <n>",
	].join("\n");
}

function parsePlanningPhase(raw: string): PlanningPhase | null {
	const value = raw.trim().toLowerCase();
	if (value === "investigating" || value === "drafting" || value === "reviewing" || value === "approved") {
		return value;
	}
	return null;
}

function planningDetails(state: PlanningUiState): {
	enabled: boolean;
	phase: PlanningPhase;
	root_issue_id: string | null;
	steps: Array<{ index: number; label: string; done: boolean }>;
} {
	return {
		enabled: state.enabled,
		phase: state.phase,
		root_issue_id: state.rootIssueId,
		steps: state.steps.map((step, index) => ({
			index: index + 1,
			label: step.label,
			done: step.done,
		})),
	};
}

function planningStatusSummary(state: PlanningUiState): string {
	const done = state.steps.filter((step) => step.done).length;
	const root = state.rootIssueId ?? "(unset)";
	return `Planning HUD: ${state.enabled ? "enabled" : "disabled"}\nphase: ${state.phase}\nroot: ${root}\nsteps: ${done}/${state.steps.length}`;
}

function planningToolError(message: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: {
			ok: false,
			error: message,
		},
	};
}

export function planningUiExtension(pi: ExtensionAPI) {
	let state = createDefaultState();

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") => {
		ctx.ui.notify(`${message}\n\n${planningUsageText()}`, level);
	};

	const refresh = (ctx: ExtensionContext) => {
		renderPlanningUi(ctx, state);
	};

	const applyPlanningAction = (params: PlanningToolParams): { ok: boolean; message: string; level?: "info" | "warning" | "error" } => {
		switch (params.action) {
			case "status":
				return { ok: true, message: planningStatusSummary(state), level: "info" };
			case "on":
				state.enabled = true;
				return { ok: true, message: "Planning HUD enabled.", level: "info" };
			case "off":
				state.enabled = false;
				return { ok: true, message: "Planning HUD disabled.", level: "info" };
			case "toggle":
				state.enabled = !state.enabled;
				return { ok: true, message: `Planning HUD ${state.enabled ? "enabled" : "disabled"}.`, level: "info" };
			case "reset":
				state = createDefaultState();
				return { ok: true, message: "Planning HUD state reset.", level: "info" };
			case "phase": {
				const phase = parsePlanningPhase(params.phase ?? "");
				if (!phase) {
					return { ok: false, message: "Invalid phase.", level: "error" };
				}
				state.phase = phase;
				state.enabled = true;
				return { ok: true, message: `Planning phase set to ${phase}.`, level: "info" };
			}
			case "root": {
				const root = params.root_issue_id?.trim();
				if (!root) {
					return { ok: false, message: "Missing root issue id.", level: "error" };
				}
				state.rootIssueId = root.toLowerCase() === "clear" ? null : root;
				state.enabled = true;
				return { ok: true, message: `Planning root set to ${state.rootIssueId ?? "(unset)"}.`, level: "info" };
			}
			case "check":
			case "uncheck":
			case "toggle_step": {
				const step = params.step;
				if (typeof step !== "number" || !Number.isFinite(step)) {
					return { ok: false, message: "Step index must be a number.", level: "error" };
				}
				const parsed = Math.trunc(step);
				if (parsed < 1 || parsed > state.steps.length) {
					return { ok: false, message: `Step index out of range (1-${state.steps.length}).`, level: "error" };
				}
				const index = parsed - 1;
				if (params.action === "check") {
					state.steps[index]!.done = true;
				} else if (params.action === "uncheck") {
					state.steps[index]!.done = false;
				} else {
					state.steps[index]!.done = !state.steps[index]!.done;
				}
				state.enabled = true;
				return { ok: true, message: `Planning step ${index + 1} updated.`, level: "info" };
			}
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		refresh(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		refresh(ctx);
	});

	registerMuSubcommand(pi, {
		subcommand: "plan",
		summary: "Planning HUD: phase + checklist widget for planning workflows",
		usage: "/mu plan on|off|toggle|status|phase|root|check|uncheck|toggle-step|reset",
		handler: async (args, ctx) => {
			const tokens = args
				.trim()
				.split(/\s+/)
				.filter((token) => token.length > 0);

			const command = tokens[0] ?? "status";
			let params: PlanningToolParams;
			switch (command) {
				case "on":
					params = { action: "on" };
					break;
				case "off":
					params = { action: "off" };
					break;
				case "toggle":
					params = { action: "toggle" };
					break;
				case "status":
					params = { action: "status" };
					break;
				case "reset":
					params = { action: "reset" };
					break;
				case "phase":
					params = { action: "phase", phase: tokens[1] };
					break;
				case "root":
					params = { action: "root", root_issue_id: tokens[1] };
					break;
				case "check":
					params = { action: "check", step: Number.parseInt(tokens[1] ?? "", 10) };
					break;
				case "uncheck":
					params = { action: "uncheck", step: Number.parseInt(tokens[1] ?? "", 10) };
					break;
				case "toggle-step":
					params = { action: "toggle_step", step: Number.parseInt(tokens[1] ?? "", 10) };
					break;
				default:
					notify(ctx, `Unknown plan command: ${command}`, "error");
					return;
			}

			const result = applyPlanningAction(params);
			refresh(ctx);
			if (!result.ok) {
				notify(ctx, result.message, result.level ?? "error");
				return;
			}
			ctx.ui.notify(result.message, result.level ?? "info");
		},
	});

	pi.registerTool({
		name: "mu_planning_hud",
		label: "mu planning HUD",
		description: "Control or inspect planning HUD state (phase, root issue, checklist progress).",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["status", "on", "off", "toggle", "reset", "phase", "root", "check", "uncheck", "toggle_step"],
				},
				phase: {
					type: "string",
					enum: ["investigating", "drafting", "reviewing", "approved"],
				},
				root_issue_id: { type: "string" },
				step: { type: "integer", minimum: 1 },
			},
			required: ["action"],
			additionalProperties: false,
		} as unknown as Parameters<ExtensionAPI["registerTool"]>[0]["parameters"],
		execute: async (_toolCallId, paramsRaw, _signal, _onUpdate, ctx) => {
			const params = paramsRaw as PlanningToolParams;
			const result = applyPlanningAction(params);
			refresh(ctx);
			if (!result.ok) {
				return planningToolError(result.message);
			}
			return {
				content: [{ type: "text", text: `${result.message}\n\n${planningStatusSummary(state)}` }],
				details: {
					ok: true,
					action: params.action,
					...planningDetails(state),
				},
			};
		},
	});
}

export default planningUiExtension;
