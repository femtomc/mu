import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

export type MuSubcommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;

export type MuSubcommandRegistration = {
	subcommand: string;
	summary: string;
	usage: string;
	handler: MuSubcommandHandler;
};

type MuSubcommandEntry = MuSubcommandRegistration & {
	normalizedSubcommand: string;
};

type MuCommandDispatcherState = {
	entries: Map<string, MuSubcommandEntry>;
};

let singletonState: MuCommandDispatcherState | null = null;

export function resetMuCommandDispatcher(): void {
	singletonState = null;
}

const RESERVED_SUBCOMMANDS = new Set(["help", "?"]);

function normalizeSubcommand(value: string): string {
	return value.trim().toLowerCase();
}

function isValidSubcommandToken(value: string): boolean {
	return /^[a-z][a-z0-9_-]*$/.test(value);
}

function subcommandUsageSummary(entry: MuSubcommandEntry): string {
	return `- ${entry.usage} — ${entry.summary}`;
}

function renderSubcommandCatalog(state: MuCommandDispatcherState): string {
	if (state.entries.size === 0) {
		return ["No /mu subcommands are currently registered.", "", "Try again after extensions finish loading."].join(
			"\n",
		);
	}

	const entries = [...state.entries.values()].sort((left, right) =>
		left.normalizedSubcommand.localeCompare(right.normalizedSubcommand),
	);
	const lines = ["Usage: /mu <subcommand> [args]", "", "Subcommands:"];
	for (const entry of entries) {
		lines.push(subcommandUsageSummary(entry));
	}
	lines.push("", "Run `/mu help <subcommand>` for focused usage.");
	return lines.join("\n");
}

function renderSubcommandHelp(entry: MuSubcommandEntry): string {
	return [entry.summary, "", `Usage: ${entry.usage}`].join("\n");
}

function parseInvocation(args: string): { subcommand: string; remainder: string } {
	const trimmed = args.trim();
	if (trimmed.length === 0) {
		return { subcommand: "", remainder: "" };
	}
	const boundary = trimmed.search(/\s/);
	if (boundary === -1) {
		return { subcommand: trimmed, remainder: "" };
	}
	return {
		subcommand: trimmed.slice(0, boundary),
		remainder: trimmed.slice(boundary + 1).trim(),
	};
}

function resolveEntry(state: MuCommandDispatcherState, token: string): MuSubcommandEntry | null {
	const normalized = normalizeSubcommand(token);
	if (!normalized) {
		return null;
	}
	return state.entries.get(normalized) ?? null;
}

function ensureDispatcher(pi: ExtensionAPI): MuCommandDispatcherState {
	if (singletonState) {
		return singletonState;
	}

	const state: MuCommandDispatcherState = {
		entries: new Map(),
	};
	singletonState = state;

	pi.registerCommand("mu", {
		description: "mu command dispatcher (`/mu <subcommand> ...`)",
		handler: async (args, ctx) => {
			const parsed = parseInvocation(args);
			if (!parsed.subcommand) {
				ctx.ui.notify(renderSubcommandCatalog(state), "info");
				return;
			}

			const normalized = normalizeSubcommand(parsed.subcommand);
			if (normalized === "help" || normalized === "?") {
				if (!parsed.remainder) {
					ctx.ui.notify(renderSubcommandCatalog(state), "info");
					return;
				}
				const detail = resolveEntry(state, parsed.remainder.split(/\s+/)[0] ?? "");
				if (!detail) {
					ctx.ui.notify(
						`Unknown mu subcommand: ${parsed.remainder}\n\n${renderSubcommandCatalog(state)}`,
						"error",
					);
					return;
				}
				ctx.ui.notify(renderSubcommandHelp(detail), "info");
				return;
			}

			const entry = resolveEntry(state, parsed.subcommand);
			if (!entry) {
				ctx.ui.notify(`Unknown mu subcommand: ${parsed.subcommand}\n\n${renderSubcommandCatalog(state)}`, "error");
				return;
			}

			await entry.handler(parsed.remainder, ctx);
		},
	});

	return state;
}

export function registerMuSubcommand(pi: ExtensionAPI, registration: MuSubcommandRegistration): void {
	const state = ensureDispatcher(pi);

	const normalizedSubcommand = normalizeSubcommand(registration.subcommand);
	if (!isValidSubcommandToken(normalizedSubcommand)) {
		throw new Error(`Invalid mu subcommand: ${registration.subcommand}`);
	}
	if (RESERVED_SUBCOMMANDS.has(normalizedSubcommand)) {
		throw new Error(`Reserved mu subcommand: ${registration.subcommand}`);
	}
	if (!registration.usage.startsWith("/mu ")) {
		throw new Error(`mu subcommand usage must start with '/mu ': ${registration.usage}`);
	}

	const entry: MuSubcommandEntry = {
		...registration,
		normalizedSubcommand,
	};
	state.entries.set(normalizedSubcommand, entry);
}
