import { z } from "zod";

export const CommandStateSchema = z.enum([
	"accepted",
	"awaiting_confirmation",
	"queued",
	"in_progress",
	"deferred",
	"completed",
	"failed",
	"cancelled",
	"expired",
	"dead_letter",
]);
export type CommandState = z.infer<typeof CommandStateSchema>;

export const TERMINAL_COMMAND_STATES = ["completed", "failed", "cancelled", "expired", "dead_letter"] as const;
export type TerminalCommandState = (typeof TERMINAL_COMMAND_STATES)[number];

export const NON_TERMINAL_COMMAND_STATES = [
	"accepted",
	"awaiting_confirmation",
	"queued",
	"in_progress",
	"deferred",
] as const;
export type NonTerminalCommandState = (typeof NON_TERMINAL_COMMAND_STATES)[number];

const ALLOWED_TRANSITIONS: Record<CommandState, readonly CommandState[]> = {
	accepted: ["awaiting_confirmation", "queued", "cancelled", "failed", "dead_letter"],
	awaiting_confirmation: ["queued", "cancelled", "expired", "dead_letter"],
	queued: ["in_progress", "cancelled", "failed", "dead_letter"],
	in_progress: ["completed", "failed", "deferred", "cancelled", "dead_letter"],
	deferred: ["queued", "failed", "cancelled", "dead_letter"],
	completed: [],
	failed: [],
	cancelled: [],
	expired: [],
	dead_letter: [],
};

const TERMINAL_SET = new Set<CommandState>(TERMINAL_COMMAND_STATES);

export function isTerminalCommandState(state: CommandState): state is TerminalCommandState {
	return TERMINAL_SET.has(state);
}

export function allowedTransitionsFrom(state: CommandState): readonly CommandState[] {
	return ALLOWED_TRANSITIONS[state];
}

export function canTransition(from: CommandState, to: CommandState): boolean {
	if (from === to) {
		return false;
	}
	return ALLOWED_TRANSITIONS[from].includes(to);
}

export class InvalidCommandTransitionError extends Error {
	public readonly from: CommandState;
	public readonly to: CommandState;

	public constructor(from: CommandState, to: CommandState) {
		super(`invalid command transition: ${from} -> ${to}`);
		this.name = "InvalidCommandTransitionError";
		this.from = from;
		this.to = to;
	}
}

export function assertValidTransition(from: CommandState, to: CommandState): void {
	if (!canTransition(from, to)) {
		throw new InvalidCommandTransitionError(from, to);
	}
}

export function lifecycleEventTypeForState(state: CommandState): string {
	return `command.${state}`;
}
