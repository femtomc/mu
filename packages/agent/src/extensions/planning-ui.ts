import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { registerMuSubcommand } from "./mu-command-dispatcher.js";

type PlanningPhase =
	| "investigating"
	| "drafting"
	| "reviewing"
	| "waiting_user"
	| "blocked"
	| "executing"
	| "approved"
	| "done";

type PlanningConfidence = "low" | "medium" | "high";

type PlanningStep = {
	label: string;
	done: boolean;
};

type PlanningUiState = {
	enabled: boolean;
	phase: PlanningPhase;
	rootIssueId: string | null;
	steps: PlanningStep[];
	waitingOnUser: boolean;
	nextAction: string | null;
	blocker: string | null;
	confidence: PlanningConfidence;
};

type PlanningStepUpdate = {
	index: number;
	done?: boolean;
	label?: string;
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
	| "toggle_step"
	| "set_steps"
	| "add_step"
	| "remove_step"
	| "set_step_label"
	| "set_waiting"
	| "set_next"
	| "set_blocker"
	| "set_confidence"
	| "update"
	| "snapshot";

type PlanningToolParams = {
	action: PlanningToolAction;
	phase?: string;
	root_issue_id?: string;
	step?: number;
	label?: string;
	waiting_on_user?: boolean;
	next_action?: string;
	blocker?: string;
	confidence?: string;
	steps?: string[];
	step_updates?: PlanningStepUpdate[];
	snapshot_format?: string;
};

const DEFAULT_STEPS = [
	"Investigate relevant code/docs/state",
	"Create root issue + decomposed child issues",
	"Present plan with IDs, ordering, risks",
	"Refine with user feedback until approved",
] as const;

const BAR_CHARS = ["░", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"] as const;
const WIDGET_STEP_LIMIT = 4;
const WIDGET_STEP_LABEL_MAX = 60;
const WIDGET_ROOT_MAX = 20;
const WIDGET_NEXT_MAX = 56;
const WIDGET_BLOCKER_MAX = 56;

function phaseTone(phase: PlanningPhase): "dim" | "accent" | "warning" | "success" {
	switch (phase) {
		case "investigating":
			return "dim";
		case "drafting":
			return "accent";
		case "reviewing":
			return "warning";
		case "waiting_user":
			return "warning";
		case "blocked":
			return "warning";
		case "executing":
			return "accent";
		case "approved":
			return "success";
		case "done":
			return "success";
	}
}

function confidenceTone(confidence: PlanningConfidence): "dim" | "accent" | "warning" | "success" {
	switch (confidence) {
		case "low":
			return "warning";
		case "medium":
			return "accent";
		case "high":
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
		waitingOnUser: false,
		nextAction: null,
		blocker: null,
		confidence: "medium",
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
		case "waiting_user":
			return "waiting-user";
		case "blocked":
			return "blocked";
		case "executing":
			return "executing";
		case "approved":
			return "approved";
		case "done":
			return "done";
	}
}

function parsePlanningPhase(raw: string): PlanningPhase | null {
	const value = raw.trim().toLowerCase();
	if (
		value === "investigating" ||
		value === "drafting" ||
		value === "reviewing" ||
		value === "waiting_user" ||
		value === "waiting-user" ||
		value === "blocked" ||
		value === "executing" ||
		value === "approved" ||
		value === "done"
	) {
		return value === "waiting-user" ? "waiting_user" : value;
	}
	return null;
}

function parsePlanningConfidence(raw: string): PlanningConfidence | null {
	const value = raw.trim().toLowerCase();
	if (value === "low" || value === "medium" || value === "high") {
		return value;
	}
	return null;
}

function parseSnapshotFormat(raw: string | undefined): "compact" | "multiline" {
	const value = (raw ?? "compact").trim().toLowerCase();
	return value === "multiline" ? "multiline" : "compact";
}

function normalizeMaybeClear(raw: string): { ok: true; value: string | null } | { ok: false; error: string } {
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return { ok: false, error: "Value must not be empty." };
	}
	if (trimmed.toLowerCase() === "clear") {
		return { ok: true, value: null };
	}
	return { ok: true, value: trimmed };
}

function normalizeSteps(labelsRaw: unknown): { ok: true; labels: string[] } | { ok: false; error: string } {
	if (!Array.isArray(labelsRaw)) {
		return { ok: false, error: "Steps must be an array of strings." };
	}
	const labels: string[] = [];
	for (let i = 0; i < labelsRaw.length; i += 1) {
		const value = labelsRaw[i];
		if (typeof value !== "string") {
			return { ok: false, error: `Step ${i + 1} must be a string.` };
		}
		const trimmed = value.trim();
		if (trimmed.length === 0) {
			return { ok: false, error: `Step ${i + 1} must not be empty.` };
		}
		labels.push(trimmed);
	}
	return { ok: true, labels };
}

function validateStepIndex(
	step: number | undefined,
	max: number,
	allowAppend = false,
): { ok: true; index: number } | { ok: false; error: string } {
	if (typeof step !== "number" || !Number.isFinite(step)) {
		return { ok: false, error: "Step index must be a number." };
	}
	const parsed = Math.trunc(step);
	const upperBound = allowAppend ? max + 1 : max;
	if (parsed < 1 || parsed > upperBound) {
		return { ok: false, error: `Step index out of range (1-${upperBound}).` };
	}
	return { ok: true, index: parsed - 1 };
}

function applyStepUpdates(
	state: PlanningUiState,
	updatesRaw: unknown,
): { ok: true; changed: number } | { ok: false; error: string } {
	if (!Array.isArray(updatesRaw)) {
		return { ok: false, error: "step_updates must be an array." };
	}
	let changed = 0;
	for (let i = 0; i < updatesRaw.length; i += 1) {
		const raw = updatesRaw[i];
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			return { ok: false, error: `step_updates[${i}] must be an object.` };
		}
		const update = raw as Record<string, unknown>;
		const indexRaw = update.index;
		if (typeof indexRaw !== "number" || !Number.isFinite(indexRaw)) {
			return { ok: false, error: `step_updates[${i}].index must be a number.` };
		}
		const stepIndex = Math.trunc(indexRaw);
		if (stepIndex < 1 || stepIndex > state.steps.length) {
			return { ok: false, error: `step_updates[${i}].index out of range (1-${state.steps.length}).` };
		}
		const doneRaw = update.done;
		const labelRaw = update.label;
		if (doneRaw === undefined && labelRaw === undefined) {
			return { ok: false, error: `step_updates[${i}] must include done and/or label.` };
		}
		const step = state.steps[stepIndex - 1];
		if (!step) {
			return { ok: false, error: `step_updates[${i}] references missing step.` };
		}
		if (doneRaw !== undefined) {
			if (typeof doneRaw !== "boolean") {
				return { ok: false, error: `step_updates[${i}].done must be a boolean.` };
			}
			if (step.done !== doneRaw) {
				step.done = doneRaw;
				changed += 1;
			}
		}
		if (labelRaw !== undefined) {
			if (typeof labelRaw !== "string") {
				return { ok: false, error: `step_updates[${i}].label must be a string.` };
			}
			const trimmed = labelRaw.trim();
			if (trimmed.length === 0) {
				return { ok: false, error: `step_updates[${i}].label must not be empty.` };
			}
			if (step.label !== trimmed) {
				step.label = trimmed;
				changed += 1;
			}
		}
	}
	return { ok: true, changed };
}

function shortLabel(value: string | null, fallback: string, maxLen = 48): string {
	if (!value || value.trim().length === 0) {
		return fallback;
	}
	const compact = value.replace(/\s+/g, " ").trim();
	if (compact.length <= maxLen) {
		return compact;
	}
	return `${compact.slice(0, Math.max(0, maxLen - 1))}…`;
}

function planningSnapshot(state: PlanningUiState, format: "compact" | "multiline"): string {
	const done = state.steps.filter((step) => step.done).length;
	const total = state.steps.length;
	const phase = summarizePhase(state.phase);
	const root = state.rootIssueId ?? "(unset)";
	const waiting = state.waitingOnUser ? "yes" : "no";
	const next = shortLabel(state.nextAction, "(unset)");
	const blocker = shortLabel(state.blocker, "(none)");
	if (format === "multiline") {
		return [
			`Planning HUD snapshot`,
			`phase: ${phase}`,
			`root: ${root}`,
			`steps: ${done}/${total}`,
			`waiting_on_user: ${waiting}`,
			`confidence: ${state.confidence}`,
			`next_action: ${next}`,
			`blocker: ${blocker}`,
		].join("\n");
	}
	return [
		`HUD(plan)`,
		`phase=${phase}`,
		`root=${root}`,
		`steps=${done}/${total}`,
		`waiting=${waiting}`,
		`confidence=${state.confidence}`,
		`next=${next}`,
		`blocker=${blocker}`,
	].join(" · ");
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
	const confidenceColor = confidenceTone(state.confidence);
	const rootLabel = state.rootIssueId ?? "(unset)";
	const meter = progressBar(done, total, 10);
	const waitingLabel = state.waitingOnUser ? "yes" : "no";
	const waitingColor: "dim" | "warning" = state.waitingOnUser ? "warning" : "dim";
	const rootCompact = shortLabel(rootLabel, "(unset)", WIDGET_ROOT_MAX);
	const nextCompact = shortLabel(state.nextAction, "(unset)", WIDGET_NEXT_MAX);
	const blockerCompact = shortLabel(state.blocker, "(none)", WIDGET_BLOCKER_MAX);
	const blockerColor: "dim" | "warning" = state.blocker ? "warning" : "dim";

	ctx.ui.setStatus(
		"mu-planning",
		[
			ctx.ui.theme.fg("dim", "plan"),
			ctx.ui.theme.fg(phaseColor, phase),
			ctx.ui.theme.fg("dim", `${done}/${total}`),
			ctx.ui.theme.fg(phaseColor, meter),
			ctx.ui.theme.fg(waitingColor, `wait:${waitingLabel}`),
			ctx.ui.theme.fg("muted", `root:${rootCompact}`),
		].join(` ${ctx.ui.theme.fg("muted", "·")} `),
	);

	const lines = [
		[
			ctx.ui.theme.fg("accent", ctx.ui.theme.bold("Planning")),
			ctx.ui.theme.fg("muted", "·"),
			ctx.ui.theme.fg(phaseColor, phase),
			ctx.ui.theme.fg("muted", "·"),
			ctx.ui.theme.fg("dim", `${done}/${total}`),
			ctx.ui.theme.fg(phaseColor, meter),
		].join(" "),
		[
			ctx.ui.theme.fg("muted", `root:${rootCompact}`),
			ctx.ui.theme.fg("muted", "·"),
			ctx.ui.theme.fg(waitingColor, `wait:${waitingLabel}`),
			ctx.ui.theme.fg("muted", "·"),
			ctx.ui.theme.fg(confidenceColor, `conf:${state.confidence}`),
		].join(" "),
		`${ctx.ui.theme.fg("muted", "next:")} ${ctx.ui.theme.fg("dim", nextCompact)}`,
	];

	if (state.blocker) {
		lines.push(`${ctx.ui.theme.fg("muted", "blocker:")} ${ctx.ui.theme.fg(blockerColor, blockerCompact)}`);
	}

	lines.push(ctx.ui.theme.fg("dim", "────────────────────────────"));

	if (state.steps.length === 0) {
		lines.push(ctx.ui.theme.fg("muted", "(no checklist steps configured)"));
	} else {
		const shownSteps = state.steps.slice(0, WIDGET_STEP_LIMIT);
		for (let index = 0; index < shownSteps.length; index += 1) {
			const step = shownSteps[index]!;
			const mark = step.done ? ctx.ui.theme.fg("success", "☑") : ctx.ui.theme.fg("muted", "☐");
			const labelText = shortLabel(step.label, "(empty)", WIDGET_STEP_LABEL_MAX);
			const label = step.done ? ctx.ui.theme.fg("dim", labelText) : ctx.ui.theme.fg("text", labelText);
			lines.push(`${mark} ${ctx.ui.theme.fg("muted", `${index + 1}.`)} ${label}`);
		}
		if (state.steps.length > shownSteps.length) {
			lines.push(ctx.ui.theme.fg("muted", `... +${state.steps.length - shownSteps.length} more steps`));
		}
	}

	ctx.ui.setWidget("mu-planning", lines, { placement: "belowEditor" });
}

function planningUsageText(): string {
	return [
		"Usage:",
		"  /mu plan on|off|toggle|status|reset|snapshot",
		"  /mu plan phase <investigating|drafting|reviewing|waiting-user|blocked|executing|approved|done>",
		"  /mu plan root <issue-id|clear>",
		"  /mu plan check <n> | /mu plan uncheck <n> | /mu plan toggle-step <n>",
		"  /mu plan add-step <label> | remove-step <n> | relabel-step <n> <label>",
		"  /mu plan waiting <on|off> | confidence <low|medium|high>",
		"  /mu plan next <text|clear> | blocker <text|clear>",
	].join("\n");
}

function parseOnOff(raw: string | undefined): boolean | null {
	const value = (raw ?? "").trim().toLowerCase();
	if (value === "on" || value === "yes" || value === "true" || value === "1") {
		return true;
	}
	if (value === "off" || value === "no" || value === "false" || value === "0") {
		return false;
	}
	return null;
}

function planningDetails(state: PlanningUiState): {
	enabled: boolean;
	phase: PlanningPhase;
	root_issue_id: string | null;
	waiting_on_user: boolean;
	next_action: string | null;
	blocker: string | null;
	confidence: PlanningConfidence;
	steps: Array<{ index: number; label: string; done: boolean }>;
	snapshot_compact: string;
	snapshot_multiline: string;
} {
	return {
		enabled: state.enabled,
		phase: state.phase,
		root_issue_id: state.rootIssueId,
		waiting_on_user: state.waitingOnUser,
		next_action: state.nextAction,
		blocker: state.blocker,
		confidence: state.confidence,
		steps: state.steps.map((step, index) => ({
			index: index + 1,
			label: step.label,
			done: step.done,
		})),
		snapshot_compact: planningSnapshot(state, "compact"),
		snapshot_multiline: planningSnapshot(state, "multiline"),
	};
}

function planningStatusSummary(state: PlanningUiState): string {
	const done = state.steps.filter((step) => step.done).length;
	const root = state.rootIssueId ?? "(unset)";
	return [
		`Planning HUD: ${state.enabled ? "enabled" : "disabled"}`,
		`phase: ${state.phase}`,
		`root: ${root}`,
		`steps: ${done}/${state.steps.length}`,
		`waiting_on_user: ${state.waitingOnUser ? "yes" : "no"}`,
		`confidence: ${state.confidence}`,
		`next_action: ${shortLabel(state.nextAction, "(unset)", 120)}`,
		`blocker: ${shortLabel(state.blocker, "(none)", 120)}`,
	].join("\n");
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

	const applyPlanningAction = (
		params: PlanningToolParams,
	): { ok: boolean; message: string; level?: "info" | "warning" | "error" } => {
		switch (params.action) {
			case "status":
				return { ok: true, message: planningStatusSummary(state), level: "info" };
			case "snapshot": {
				const format = parseSnapshotFormat(params.snapshot_format);
				return { ok: true, message: planningSnapshot(state, format), level: "info" };
			}
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
				const rootRaw = params.root_issue_id;
				if (typeof rootRaw !== "string") {
					return { ok: false, message: "Missing root issue id.", level: "error" };
				}
				const normalized = normalizeMaybeClear(rootRaw);
				if (!normalized.ok) {
					return { ok: false, message: "Missing root issue id.", level: "error" };
				}
				state.rootIssueId = normalized.value;
				state.enabled = true;
				return { ok: true, message: `Planning root set to ${state.rootIssueId ?? "(unset)"}.`, level: "info" };
			}
			case "check":
			case "uncheck":
			case "toggle_step": {
				const parsedIndex = validateStepIndex(params.step, state.steps.length);
				if (!parsedIndex.ok) {
					return { ok: false, message: parsedIndex.error, level: "error" };
				}
				const step = state.steps[parsedIndex.index];
				if (!step) {
					return { ok: false, message: "Step index out of range.", level: "error" };
				}
				if (params.action === "check") {
					step.done = true;
				} else if (params.action === "uncheck") {
					step.done = false;
				} else {
					step.done = !step.done;
				}
				state.enabled = true;
				return { ok: true, message: `Planning step ${parsedIndex.index + 1} updated.`, level: "info" };
			}
			case "set_steps": {
				const normalized = normalizeSteps(params.steps);
				if (!normalized.ok) {
					return { ok: false, message: normalized.error, level: "error" };
				}
				state.steps = normalized.labels.map((label) => ({ label, done: false }));
				state.enabled = true;
				return { ok: true, message: `Planning checklist replaced (${state.steps.length} steps).`, level: "info" };
			}
			case "add_step": {
				const labelRaw = params.label;
				if (typeof labelRaw !== "string" || labelRaw.trim().length === 0) {
					return { ok: false, message: "Missing step label.", level: "error" };
				}
				const label = labelRaw.trim();
				let insertIndex = state.steps.length;
				if (params.step !== undefined) {
					const parsedIndex = validateStepIndex(params.step, state.steps.length, true);
					if (!parsedIndex.ok) {
						return { ok: false, message: parsedIndex.error, level: "error" };
					}
					insertIndex = parsedIndex.index;
				}
				state.steps.splice(insertIndex, 0, { label, done: false });
				state.enabled = true;
				return { ok: true, message: `Added planning step ${insertIndex + 1}.`, level: "info" };
			}
			case "remove_step": {
				const parsedIndex = validateStepIndex(params.step, state.steps.length);
				if (!parsedIndex.ok) {
					return { ok: false, message: parsedIndex.error, level: "error" };
				}
				state.steps.splice(parsedIndex.index, 1);
				state.enabled = true;
				return { ok: true, message: `Removed planning step ${parsedIndex.index + 1}.`, level: "info" };
			}
			case "set_step_label": {
				const parsedIndex = validateStepIndex(params.step, state.steps.length);
				if (!parsedIndex.ok) {
					return { ok: false, message: parsedIndex.error, level: "error" };
				}
				const labelRaw = params.label;
				if (typeof labelRaw !== "string" || labelRaw.trim().length === 0) {
					return { ok: false, message: "Missing step label.", level: "error" };
				}
				const step = state.steps[parsedIndex.index];
				if (!step) {
					return { ok: false, message: "Step index out of range.", level: "error" };
				}
				step.label = labelRaw.trim();
				state.enabled = true;
				return { ok: true, message: `Planning step ${parsedIndex.index + 1} relabeled.`, level: "info" };
			}
			case "set_waiting": {
				if (typeof params.waiting_on_user !== "boolean") {
					return { ok: false, message: "waiting_on_user must be a boolean.", level: "error" };
				}
				state.waitingOnUser = params.waiting_on_user;
				state.enabled = true;
				return {
					ok: true,
					message: `Planning waiting_on_user set to ${state.waitingOnUser ? "yes" : "no"}.`,
					level: "info",
				};
			}
			case "set_next": {
				const nextRaw = params.next_action;
				if (typeof nextRaw !== "string") {
					return { ok: false, message: "Missing next_action value.", level: "error" };
				}
				const normalized = normalizeMaybeClear(nextRaw);
				if (!normalized.ok) {
					return { ok: false, message: "Missing next_action value.", level: "error" };
				}
				state.nextAction = normalized.value;
				state.enabled = true;
				return {
					ok: true,
					message: `Planning next_action set to ${shortLabel(state.nextAction, "(unset)")}.`,
					level: "info",
				};
			}
			case "set_blocker": {
				const blockerRaw = params.blocker;
				if (typeof blockerRaw !== "string") {
					return { ok: false, message: "Missing blocker value.", level: "error" };
				}
				const normalized = normalizeMaybeClear(blockerRaw);
				if (!normalized.ok) {
					return { ok: false, message: "Missing blocker value.", level: "error" };
				}
				state.blocker = normalized.value;
				state.enabled = true;
				return {
					ok: true,
					message: `Planning blocker set to ${shortLabel(state.blocker, "(none)")}.`,
					level: "info",
				};
			}
			case "set_confidence": {
				const confidence = parsePlanningConfidence(params.confidence ?? "");
				if (!confidence) {
					return { ok: false, message: "Invalid confidence.", level: "error" };
				}
				state.confidence = confidence;
				state.enabled = true;
				return { ok: true, message: `Planning confidence set to ${confidence}.`, level: "info" };
			}
			case "update": {
				const changed: string[] = [];

				if (params.phase !== undefined) {
					const phase = parsePlanningPhase(params.phase);
					if (!phase) {
						return { ok: false, message: "Invalid phase.", level: "error" };
					}
					state.phase = phase;
					changed.push("phase");
				}

				if (params.root_issue_id !== undefined) {
					if (typeof params.root_issue_id !== "string") {
						return { ok: false, message: "root_issue_id must be a string.", level: "error" };
					}
					const normalized = normalizeMaybeClear(params.root_issue_id);
					if (!normalized.ok) {
						return { ok: false, message: "root_issue_id must not be empty.", level: "error" };
					}
					state.rootIssueId = normalized.value;
					changed.push("root_issue_id");
				}

				if (params.waiting_on_user !== undefined) {
					if (typeof params.waiting_on_user !== "boolean") {
						return { ok: false, message: "waiting_on_user must be a boolean.", level: "error" };
					}
					state.waitingOnUser = params.waiting_on_user;
					changed.push("waiting_on_user");
				}

				if (params.next_action !== undefined) {
					if (typeof params.next_action !== "string") {
						return { ok: false, message: "next_action must be a string.", level: "error" };
					}
					const normalized = normalizeMaybeClear(params.next_action);
					if (!normalized.ok) {
						return { ok: false, message: "next_action must not be empty.", level: "error" };
					}
					state.nextAction = normalized.value;
					changed.push("next_action");
				}

				if (params.blocker !== undefined) {
					if (typeof params.blocker !== "string") {
						return { ok: false, message: "blocker must be a string.", level: "error" };
					}
					const normalized = normalizeMaybeClear(params.blocker);
					if (!normalized.ok) {
						return { ok: false, message: "blocker must not be empty.", level: "error" };
					}
					state.blocker = normalized.value;
					changed.push("blocker");
				}

				if (params.confidence !== undefined) {
					const confidence = parsePlanningConfidence(params.confidence);
					if (!confidence) {
						return { ok: false, message: "Invalid confidence.", level: "error" };
					}
					state.confidence = confidence;
					changed.push("confidence");
				}

				if (params.steps !== undefined) {
					const normalized = normalizeSteps(params.steps);
					if (!normalized.ok) {
						return { ok: false, message: normalized.error, level: "error" };
					}
					state.steps = normalized.labels.map((label) => ({ label, done: false }));
					changed.push("steps");
				}

				if (params.step_updates !== undefined) {
					const updated = applyStepUpdates(state, params.step_updates);
					if (!updated.ok) {
						return { ok: false, message: updated.error, level: "error" };
					}
					changed.push("step_updates");
				}

				if (changed.length === 0) {
					return { ok: false, message: "No update fields provided.", level: "error" };
				}

				state.enabled = true;
				return {
					ok: true,
					message: `Planning HUD updated (${changed.join(", ")}).`,
					level: "info",
				};
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
		summary: "Planning HUD: phase + checklist + communication state for planning workflows",
		usage: "/mu plan on|off|toggle|status|reset|snapshot|phase|root|check|uncheck|toggle-step|add-step|remove-step|relabel-step|waiting|next|blocker|confidence",
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
				case "snapshot":
					params = { action: "snapshot", snapshot_format: tokens[1] };
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
				case "add-step":
					params = { action: "add_step", label: tokens.slice(1).join(" ") };
					break;
				case "remove-step":
					params = { action: "remove_step", step: Number.parseInt(tokens[1] ?? "", 10) };
					break;
				case "relabel-step":
					params = {
						action: "set_step_label",
						step: Number.parseInt(tokens[1] ?? "", 10),
						label: tokens.slice(2).join(" "),
					};
					break;
				case "waiting": {
					const parsed = parseOnOff(tokens[1]);
					params = { action: "set_waiting", waiting_on_user: parsed ?? undefined };
					break;
				}
				case "next":
					params = { action: "set_next", next_action: tokens.slice(1).join(" ") };
					break;
				case "blocker":
					params = { action: "set_blocker", blocker: tokens.slice(1).join(" ") };
					break;
				case "confidence":
					params = { action: "set_confidence", confidence: tokens[1] };
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
		description: "Control or inspect planning HUD state (phase, root issue, checklist, and communication metadata).",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: [
						"status",
						"on",
						"off",
						"toggle",
						"reset",
						"phase",
						"root",
						"check",
						"uncheck",
						"toggle_step",
						"set_steps",
						"add_step",
						"remove_step",
						"set_step_label",
						"set_waiting",
						"set_next",
						"set_blocker",
						"set_confidence",
						"update",
						"snapshot",
					],
				},
				phase: {
					type: "string",
					enum: [
						"investigating",
						"drafting",
						"reviewing",
						"waiting_user",
						"blocked",
						"executing",
						"approved",
						"done",
					],
				},
				root_issue_id: { type: "string" },
				step: { type: "integer", minimum: 1 },
				label: { type: "string" },
				waiting_on_user: { type: "boolean" },
				next_action: { type: "string" },
				blocker: { type: "string" },
				confidence: {
					type: "string",
					enum: ["low", "medium", "high"],
				},
				steps: {
					type: "array",
					items: { type: "string" },
				},
				step_updates: {
					type: "array",
					items: {
						type: "object",
						properties: {
							index: { type: "integer", minimum: 1 },
							done: { type: "boolean" },
							label: { type: "string" },
						},
						required: ["index"],
						additionalProperties: false,
					},
				},
				snapshot_format: {
					type: "string",
					enum: ["compact", "multiline"],
				},
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
