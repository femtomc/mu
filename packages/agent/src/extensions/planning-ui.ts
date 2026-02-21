import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { registerMuSubcommand } from "./mu-command-dispatcher.js";

type PlanningPhase = "investigating" | "drafting" | "reviewing" | "approved";

type PlanningUiState = {
	enabled: boolean;
	phase: PlanningPhase;
	rootIssueId: string | null;
	steps: Array<{ label: string; done: boolean }>;
};

const DEFAULT_STEPS = [
	"Investigate relevant code/docs/state",
	"Create root issue + decomposed child issues",
	"Present plan with IDs, ordering, risks",
	"Refine with user feedback until approved",
] as const;

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
	const rootSuffix = state.rootIssueId ? ` root:${state.rootIssueId}` : "";

	ctx.ui.setStatus(
		"mu-planning",
		ctx.ui.theme.fg("dim", `planning ${done}/${total} · ${phase}${rootSuffix}`),
	);

	const lines = [
		ctx.ui.theme.fg("accent", `Planning (${phase})`),
		state.rootIssueId
			? ctx.ui.theme.fg("dim", `  root issue: ${state.rootIssueId}`)
			: ctx.ui.theme.fg("dim", "  root issue: (unset)"),
		...state.steps.map((step, index) => {
			const mark = step.done ? ctx.ui.theme.fg("success", "☑") : ctx.ui.theme.fg("muted", "☐");
			return `${mark} ${index + 1}. ${step.label}`;
		}),
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

export function planningUiExtension(pi: ExtensionAPI) {
	let state = createDefaultState();

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") => {
		ctx.ui.notify(`${message}\n\n${planningUsageText()}`, level);
	};

	const refresh = (ctx: ExtensionContext) => {
		renderPlanningUi(ctx, state);
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

			if (tokens.length === 0 || tokens[0] === "status") {
				const done = state.steps.filter((step) => step.done).length;
				const root = state.rootIssueId ?? "(unset)";
				ctx.ui.notify(
					`Planning HUD: ${state.enabled ? "enabled" : "disabled"}\nphase: ${state.phase}\nroot: ${root}\nsteps: ${done}/${state.steps.length}`,
					"info",
				);
				refresh(ctx);
				return;
			}

			switch (tokens[0]) {
				case "on":
					state.enabled = true;
					refresh(ctx);
					ctx.ui.notify("Planning HUD enabled.", "info");
					return;
				case "off":
					state.enabled = false;
					refresh(ctx);
					ctx.ui.notify("Planning HUD disabled.", "info");
					return;
				case "toggle":
					state.enabled = !state.enabled;
					refresh(ctx);
					ctx.ui.notify(`Planning HUD ${state.enabled ? "enabled" : "disabled"}.`, "info");
					return;
				case "reset":
					state = createDefaultState();
					refresh(ctx);
					ctx.ui.notify("Planning HUD state reset.", "info");
					return;
				case "phase": {
					const phase = parsePlanningPhase(tokens[1] ?? "");
					if (!phase) {
						notify(ctx, "Invalid phase.", "error");
						return;
					}
					state.phase = phase;
					state.enabled = true;
					refresh(ctx);
					ctx.ui.notify(`Planning phase set to ${phase}.`, "info");
					return;
				}
				case "root": {
					const value = (tokens[1] ?? "").trim();
					if (!value) {
						notify(ctx, "Missing root issue id.", "error");
						return;
					}
					state.rootIssueId = value.toLowerCase() === "clear" ? null : value;
					state.enabled = true;
					refresh(ctx);
					ctx.ui.notify(`Planning root set to ${state.rootIssueId ?? "(unset)"}.`, "info");
					return;
				}
				case "check":
				case "uncheck":
				case "toggle-step": {
					const indexRaw = tokens[1] ?? "";
					const parsed = Number.parseInt(indexRaw, 10);
					if (!Number.isFinite(parsed)) {
						notify(ctx, "Step index must be a number.", "error");
						return;
					}
					if (parsed < 1 || parsed > state.steps.length) {
						notify(ctx, `Step index out of range (1-${state.steps.length}).`, "error");
						return;
					}
					const index = parsed - 1;
					if (tokens[0] === "check") {
						state.steps[index]!.done = true;
					} else if (tokens[0] === "uncheck") {
						state.steps[index]!.done = false;
					} else {
						state.steps[index]!.done = !state.steps[index]!.done;
					}
					state.enabled = true;
					refresh(ctx);
					ctx.ui.notify(`Planning step ${index + 1} updated.`, "info");
					return;
				}
				default:
					notify(ctx, `Unknown plan command: ${tokens[0]}`, "error");
			}
		},
	});
}

export default planningUiExtension;
