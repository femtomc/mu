export type CommandInvocation = "slash" | "mu_bang" | "mu_question";

export type ParsedCommand =
	| { kind: "noop"; reason: "not_command" | "empty_input"; raw: string }
	| { kind: "invalid"; reason: "empty_command" | "missing_command_id"; raw: string }
	| {
			kind: "command";
			invocation: CommandInvocation;
			requestedMode: "auto" | "mutation" | "readonly";
			commandKey: string;
			args: string[];
			normalized: string;
	  }
	| {
			kind: "confirm";
			invocation: CommandInvocation;
			requestedMode: "auto" | "mutation" | "readonly";
			commandId: string;
			normalized: string;
	  }
	| {
			kind: "cancel";
			invocation: CommandInvocation;
			requestedMode: "auto" | "mutation" | "readonly";
			commandId: string;
			normalized: string;
	  };

const KNOWN_THREE_TOKEN_COMMANDS = new Set([
	"issue dep add",
	"issue dep remove",
	"kill-switch set",
	"rate-limit override",
	"operator config get",
	"operator model list",
	"operator thinking list",
	"operator model set",
	"operator thinking set",
]);

const KNOWN_TWO_TOKEN_COMMANDS = new Set([
	"issue get",
	"issue list",
	"issue create",
	"issue update",
	"issue claim",
	"issue close",
	"forum read",
	"forum post",
	"audit get",
	"link begin",
	"link finish",
	"unlink self",
	"grant scope",
	"policy update",
	"dlq list",
	"dlq inspect",
	"dlq replay",
]);

const KNOWN_ONE_TOKEN_COMMANDS = new Set(["status", "ready", "revoke", "reload", "update"]);

function parseInvocation(raw: string): {
	invocation: CommandInvocation;
	requestedMode: "auto" | "mutation" | "readonly";
	body: string;
} | null {
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return null;
	}

	const slashReloadMatch = /^\/(reload|update)(?:\s+(.*))?$/i.exec(trimmed);
	if (slashReloadMatch) {
		return {
			invocation: "slash",
			requestedMode: "auto",
			body: [slashReloadMatch[1]?.toLowerCase() ?? "", (slashReloadMatch[2] ?? "").trim()].filter(Boolean).join(" "),
		};
	}

	const slashMatch = /^\/mu(?:\s+(.*))?$/.exec(trimmed);
	if (slashMatch) {
		return {
			invocation: "slash",
			requestedMode: "auto",
			body: (slashMatch[1] ?? "").trim(),
		};
	}

	const textMatch = /^mu([!?])(?:\s+(.*))?$/.exec(trimmed);
	if (!textMatch) {
		return null;
	}

	return {
		invocation: textMatch[1] === "!" ? "mu_bang" : "mu_question",
		requestedMode: textMatch[1] === "!" ? "mutation" : "readonly",
		body: (textMatch[2] ?? "").trim(),
	};
}

function splitTokens(body: string): string[] {
	return body
		.split(/\s+/)
		.map((token) => token.trim())
		.filter((token) => token.length > 0);
}

function deriveCommandKey(tokensLower: readonly string[]): { commandKey: string; tokenCount: number } {
	if (tokensLower.length >= 3) {
		const key = `${tokensLower[0]} ${tokensLower[1]} ${tokensLower[2]}`;
		if (KNOWN_THREE_TOKEN_COMMANDS.has(key)) {
			return { commandKey: key, tokenCount: 3 };
		}
	}
	if (tokensLower.length >= 2) {
		const key = `${tokensLower[0]} ${tokensLower[1]}`;
		if (KNOWN_TWO_TOKEN_COMMANDS.has(key)) {
			return { commandKey: key, tokenCount: 2 };
		}
	}
	if (KNOWN_ONE_TOKEN_COMMANDS.has(tokensLower[0]!)) {
		return { commandKey: tokensLower[0]!, tokenCount: 1 };
	}

	if (tokensLower[0] === "run" || tokensLower[0] === "runs") {
		return { commandKey: tokensLower[0]!, tokenCount: 1 };
	}

	if (tokensLower.length >= 2) {
		return { commandKey: `${tokensLower[0]} ${tokensLower[1]}`, tokenCount: 2 };
	}
	return { commandKey: tokensLower[0]!, tokenCount: 1 };
}

export function parseSeriousWorkCommand(raw: string): ParsedCommand {
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return { kind: "noop", reason: "empty_input", raw };
	}

	const invocation = parseInvocation(raw);
	if (!invocation) {
		return { kind: "noop", reason: "not_command", raw };
	}
	if (invocation.body.length === 0) {
		return { kind: "invalid", reason: "empty_command", raw };
	}

	const tokens = splitTokens(invocation.body);
	if (tokens.length === 0) {
		return { kind: "invalid", reason: "empty_command", raw };
	}

	const lower = tokens.map((token) => token.toLowerCase());
	if (lower[0] === "confirm") {
		if (!tokens[1]) {
			return { kind: "invalid", reason: "missing_command_id", raw };
		}
		return {
			kind: "confirm",
			invocation: invocation.invocation,
			requestedMode: invocation.requestedMode,
			commandId: tokens[1]!,
			normalized: `confirm ${tokens[1]!}`,
		};
	}

	if (lower[0] === "cancel") {
		if (!tokens[1]) {
			return { kind: "invalid", reason: "missing_command_id", raw };
		}
		return {
			kind: "cancel",
			invocation: invocation.invocation,
			requestedMode: invocation.requestedMode,
			commandId: tokens[1]!,
			normalized: `cancel ${tokens[1]!}`,
		};
	}

	const { commandKey, tokenCount } = deriveCommandKey(lower);
	const args = tokens.slice(tokenCount);
	return {
		kind: "command",
		invocation: invocation.invocation,
		requestedMode: invocation.requestedMode,
		commandKey,
		args,
		normalized: [commandKey, ...args].join(" ").trim(),
	};
}
