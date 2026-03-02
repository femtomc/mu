import { join } from "node:path";

export type ControlCommandRunResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

export type ControlCommandDeps = {
	hasHelpFlag: (argv: readonly string[]) => boolean;
	popFlag: (argv: readonly string[], name: string) => { present: boolean; rest: string[] };
	getFlagValue: (argv: readonly string[], name: string) => { value: string | null; rest: string[] };
	getRepeatFlagValues: (argv: readonly string[], names: readonly string[]) => { values: string[]; rest: string[] };
	ensureInt: (value: string, opts: { name: string; min?: number; max?: number }) => number | null;
	jsonError: (
		msg: string,
		opts?: { pretty?: boolean; recovery?: readonly string[] },
	) => ControlCommandRunResult;
	jsonText: (data: unknown, pretty: boolean) => string;
	ok: (stdout?: string, exitCode?: number) => ControlCommandRunResult;
	fileExists: (path: string) => Promise<boolean>;
	nonEmptyString: (value: unknown) => string | undefined;
	describeError: (err: unknown) => string;
	storePathForRepoRoot: (repoRoot: string, ...parts: string[]) => string;
	detectRunningServer: (repoRoot: string) => Promise<{ url: string; port: number; pid: number } | null>;
	readApiError: (response: Response, payloadOverride?: unknown) => Promise<string>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value == null || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

type ControlConfigValueKind = "secret_string" | "boolean" | "integer";

type ControlConfigKeySpec = {
	key: string;
	kind: ControlConfigValueKind;
	path: readonly string[];
	description: string;
	defaultValue: string | number | boolean | null;
	min?: number;
	max?: number;
};

const CONTROL_CONFIG_KEY_SPECS: readonly ControlConfigKeySpec[] = [
	{
		key: "control_plane.adapters.slack.signing_secret",
		kind: "secret_string",
		path: ["control_plane", "adapters", "slack", "signing_secret"],
		description: "Slack ingress signing secret",
		defaultValue: null,
	},
	{
		key: "control_plane.adapters.slack.bot_token",
		kind: "secret_string",
		path: ["control_plane", "adapters", "slack", "bot_token"],
		description: "Slack bot token for outbound delivery/media",
		defaultValue: null,
	},
	{
		key: "control_plane.adapters.discord.signing_secret",
		kind: "secret_string",
		path: ["control_plane", "adapters", "discord", "signing_secret"],
		description: "Discord ingress signing secret",
		defaultValue: null,
	},
	{
		key: "control_plane.adapters.telegram.webhook_secret",
		kind: "secret_string",
		path: ["control_plane", "adapters", "telegram", "webhook_secret"],
		description: "Telegram webhook secret token",
		defaultValue: null,
	},
	{
		key: "control_plane.adapters.telegram.bot_token",
		kind: "secret_string",
		path: ["control_plane", "adapters", "telegram", "bot_token"],
		description: "Telegram bot token for outbound delivery/media",
		defaultValue: null,
	},
	{
		key: "control_plane.adapters.neovim.shared_secret",
		kind: "secret_string",
		path: ["control_plane", "adapters", "neovim", "shared_secret"],
		description: "Neovim shared-secret header value",
		defaultValue: null,
	},
	{
		key: "control_plane.operator.enabled",
		kind: "boolean",
		path: ["control_plane", "operator", "enabled"],
		description: "Enable/disable messaging operator runtime",
		defaultValue: true,
	},
	{
		key: "control_plane.operator.timeout_ms",
		kind: "integer",
		path: ["control_plane", "operator", "timeout_ms"],
		description: "Operator turn timeout in milliseconds",
		defaultValue: 600_000,
		min: 1_000,
		max: 7_200_000,
	},
	{
		key: "control_plane.memory_index.enabled",
		kind: "boolean",
		path: ["control_plane", "memory_index", "enabled"],
		description: "Enable background memory index maintenance",
		defaultValue: true,
	},
	{
		key: "control_plane.memory_index.every_ms",
		kind: "integer",
		path: ["control_plane", "memory_index", "every_ms"],
		description: "Memory index maintenance interval (ms)",
		defaultValue: 300_000,
		min: 1_000,
		max: 86_400_000,
	},
];

const CONTROL_CONFIG_KEY_BY_NAME = new Map<string, ControlConfigKeySpec>(
	CONTROL_CONFIG_KEY_SPECS.map((spec) => [spec.key, spec]),
);

function readControlConfigPathValue(root: unknown, path: readonly string[]): unknown {
	let cursor: unknown = root;
	for (const segment of path) {
		if (typeof cursor !== "object" || cursor == null || Array.isArray(cursor)) {
			return undefined;
		}
		cursor = (cursor as Record<string, unknown>)[segment];
	}
	return cursor;
}

function buildControlConfigPatch(path: readonly string[], value: unknown): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	let cursor: Record<string, unknown> = patch;
	for (let idx = 0; idx < path.length; idx += 1) {
		const segment = path[idx]!;
		if (idx === path.length - 1) {
			cursor[segment] = value;
			break;
		}
		const child: Record<string, unknown> = {};
		cursor[segment] = child;
		cursor = child;
	}
	return patch;
}

function parseControlConfigBoolean(raw: string): boolean | null {
	const normalized = raw.trim().toLowerCase();
	if (["1", "true", "yes", "on", "enabled"].includes(normalized)) {
		return true;
	}
	if (["0", "false", "no", "off", "disabled"].includes(normalized)) {
		return false;
	}
	return null;
}

function trimSingleTrailingNewline(text: string): string {
	return text.replace(/\r?\n$/, "");
}

function buildControlConfigKeySummary(spec: ControlConfigKeySpec): string {
	switch (spec.kind) {
		case "secret_string":
			return `${spec.key} (secret)`;
		case "boolean":
			return `${spec.key} (boolean)`;
		default:
			return `${spec.key} (integer)`;
	}
}

function normalizeUiStateScopeKind(raw: string | null | undefined): "session" | "conversation" | null {
	if (typeof raw !== "string") {
		return null;
	}
	const normalized = raw.trim().toLowerCase();
	if (normalized === "session" || normalized === "conversation") {
		return normalized;
	}
	return null;
}

function normalizeUiStateScopeId(raw: string | null | undefined): string | null {
	if (typeof raw !== "string") {
		return null;
	}
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function isoForTsMs(value: number): string {
	try {
		return new Date(value).toISOString();
	} catch {
		return String(value);
	}
}

function compactWriterSummary(writer: Record<string, unknown>): string {
	const source = typeof writer.source === "string" && writer.source.trim().length > 0 ? writer.source.trim() : "unknown";
	const requestId =
		typeof writer.request_id === "string" && writer.request_id.trim().length > 0 ? writer.request_id.trim() : null;
	const sessionId =
		typeof writer.session_id === "string" && writer.session_id.trim().length > 0 ? writer.session_id.trim() : null;
	const wakeId = typeof writer.wake_id === "string" && writer.wake_id.trim().length > 0 ? writer.wake_id.trim() : null;
	const parts = [source];
	if (sessionId) {
		parts.push(`session=${sessionId}`);
	}
	if (wakeId) {
		parts.push(`wake=${wakeId}`);
	}
	if (requestId) {
		parts.push(`request=${requestId}`);
	}
	return parts.join(" ");
}

function buildControlHandlers<Ctx extends { repoRoot: string }>(deps: ControlCommandDeps): {
	cmdControl: (argv: string[], ctx: Ctx) => Promise<ControlCommandRunResult>;
} {
	const {
		hasHelpFlag,
		popFlag,
		getFlagValue,
		getRepeatFlagValues,
		ensureInt,
		jsonError,
		jsonText,
		ok,
		fileExists,
		nonEmptyString,
		describeError,
		storePathForRepoRoot,
		detectRunningServer,
		readApiError,
	} = deps;

	async function cmdControl(argv: string[], ctx: Ctx): Promise<ControlCommandRunResult> {
		const { present: pretty, rest: argv0 } = popFlag(argv, "--pretty");

		if (argv0.length === 0 || argv0[0] === "--help" || argv0[0] === "-h") {
			return ok(
				[
					"mu control - control-plane identity, adapter, and operator config",
					"",
					"Usage:",
					"  mu control <command> [args...] [--pretty]",
					"",
					"Commands:",
					"  link               Link a channel identity",
					"  unlink             Unlink a binding (self-unlink or admin revoke)",
					"  identities         List identity bindings",
					"  status             Show adapter/operator/config readiness",
					"  harness            Show harness adapter/provider/model capabilities",
					"  operator           Inspect/update operator model + thinking",
					"  config             Inspect/update workspace control-plane config",
					"  ui-state           Inspect persisted UiDoc scope/revision state",
					"  reload             Trigger in-process control-plane reload",
					"  update             Run update command then trigger reload",
					"  diagnose-operator  Diagnose operator turn parsing/execution health",
					"",
					"Examples:",
					"  mu control status",
					"  mu control harness",
					"  mu control identities --all",
					"  mu control link --channel telegram --actor-id <chat-id> --tenant-id telegram-bot",
					"  mu control operator models",
					"  mu control operator set <provider> <model> <thinking>",
					"  mu control config get",
					"  mu control config set control_plane.operator.enabled false",
					"  mu control ui-state list",
					"  mu control reload",
					"",
					"Run `mu control <subcommand> --help` for subcommand-specific usage.",
					"See also: `mu guide`",
				].join("\n") + "\n",
			);
		}

		const sub = argv0[0]!;
		const rest = argv0.slice(1);

		switch (sub) {
			case "link":
				return await controlLink(rest, ctx, pretty);
			case "unlink":
				return await controlUnlink(rest, ctx, pretty);
			case "identities":
				return await controlIdentities(rest, ctx, pretty);
			case "status":
				return await controlStatus(rest, ctx, pretty);
			case "harness":
				return await controlHarness(rest, ctx, pretty);
			case "operator":
				return await controlOperator(rest, ctx, pretty);
			case "config":
				return await controlConfig(rest, ctx, pretty);
			case "ui-state":
				return await controlUiState(rest, ctx, pretty);
			case "reload":
				return await controlReload(rest, ctx, pretty);
			case "update":
				return await controlUpdate(rest, ctx, pretty);
			case "diagnose-operator":
				return await controlDiagnoseOperator(rest, ctx, pretty);
			default:
				return jsonError(`unknown subcommand: ${sub}`, { pretty, recovery: ["mu control --help"] });
		}
	}

	async function controlDiagnoseOperator(argv: string[], ctx: Ctx, pretty: boolean): Promise<ControlCommandRunResult> {
		if (hasHelpFlag(argv)) {
			return ok(
				[
					"mu control diagnose-operator - inspect operator decision parsing/execution health",
					"",
					"Usage:",
					"  mu control diagnose-operator [--limit N] [--json] [--pretty]",
					"",
					"Reads:",
					"  <store>/control-plane/operator_turns.jsonl",
					"  <store>/control-plane/commands.jsonl",
					"",
					"Examples:",
					"  mu control diagnose-operator",
					"  mu control diagnose-operator --limit 50 --json --pretty",
				].join("\n") + "\n",
			);
		}

		const { present: jsonMode, rest: argv0 } = popFlag(argv, "--json");
		const { value: limitRaw, rest } = getFlagValue(argv0, "--limit");
		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, {
				pretty,
				recovery: ["mu control diagnose-operator --help"],
			});
		}

		const limit = limitRaw ? ensureInt(limitRaw, { name: "--limit", min: 1, max: 500 }) : 20;
		if (limit == null) {
			return jsonError("limit must be an integer between 1 and 500", {
				pretty,
				recovery: ["mu control diagnose-operator --limit 20"],
			});
		}

		const asRecord = (value: unknown): Record<string, unknown> | null =>
			typeof value === "object" && value != null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

		const formatTs = (ts: number): string => {
			try {
				return new Date(ts).toISOString();
			} catch {
				return String(ts);
			}
		};

		const { readJsonl } = await import("@femtomc/mu-core/node");
		const { getControlPlanePaths } = await import("@femtomc/mu-control-plane");
		const paths = getControlPlanePaths(ctx.repoRoot);
		const turnsPath = join(paths.controlPlaneDir, "operator_turns.jsonl");
		const turnsExists = await fileExists(turnsPath);

		const turns: Array<{
			ts_ms: number;
			request_id: string;
			session_id: string | null;
			turn_id: string | null;
			outcome: string;
			reason: string | null;
			message_preview: string | null;
			command_kind: string | null;
		}> = [];

		if (turnsExists) {
			try {
				const rows = await readJsonl(turnsPath);
				for (const row of rows) {
					const rec = asRecord(row);
					if (!rec || rec.kind !== "operator.turn") {
						continue;
					}
					const ts = typeof rec.ts_ms === "number" && Number.isFinite(rec.ts_ms) ? Math.trunc(rec.ts_ms) : null;
					const requestId = nonEmptyString(rec.request_id);
					const outcome = nonEmptyString(rec.outcome);
					if (ts == null || !requestId || !outcome) {
						continue;
					}
					const command = asRecord(rec.command);
					turns.push({
						ts_ms: ts,
						request_id: requestId,
						session_id: nonEmptyString(rec.session_id) ?? null,
						turn_id: nonEmptyString(rec.turn_id) ?? null,
						outcome,
						reason: nonEmptyString(rec.reason) ?? null,
						message_preview: nonEmptyString(rec.message_preview) ?? null,
						command_kind: nonEmptyString(command?.kind) ?? null,
					});
				}
			} catch (err) {
				return jsonError(`failed to read operator turn audit: ${describeError(err)}`, {
					pretty,
					recovery: ["mu control diagnose-operator --json --pretty"],
				});
			}
		}

		turns.sort((a, b) => a.ts_ms - b.ts_ms);

		const outcomeCounts: Record<string, number> = {};
		for (const t of turns) {
			outcomeCounts[t.outcome] = (outcomeCounts[t.outcome] ?? 0) + 1;
		}

		const recentTurns = turns
			.slice(-limit)
			.reverse()
			.map((t) => ({
				ts_ms: t.ts_ms,
				ts_iso: formatTs(t.ts_ms),
				request_id: t.request_id,
				outcome: t.outcome,
				reason: t.reason,
				command_kind: t.command_kind,
				message_preview: t.message_preview,
			}));

		const problematicTurns = turns
			.filter((t) => t.outcome === "invalid_directive" || t.outcome === "error")
			.slice(-limit)
			.reverse()
			.map((t) => ({
				ts_ms: t.ts_ms,
				ts_iso: formatTs(t.ts_ms),
				request_id: t.request_id,
				outcome: t.outcome,
				reason: t.reason,
				message_preview: t.message_preview,
			}));

		const operatorLifecycleRows: Array<{
			ts_ms: number;
			event_type: string;
			command_id: string;
			target_type: string;
			state: string;
			error_code: string | null;
			operator_session_id: string;
			operator_turn_id: string | null;
		}> = [];

		if (await fileExists(paths.commandsPath)) {
			try {
				const commandRows = await readJsonl(paths.commandsPath);
				for (const row of commandRows) {
					const rec = asRecord(row);
					if (!rec || rec.kind !== "command.lifecycle") {
						continue;
					}
					const command = asRecord(rec.command);
					if (!command) {
						continue;
					}
					const sessionId = nonEmptyString(command.operator_session_id);
					if (!sessionId) {
						continue;
					}
					const ts = typeof rec.ts_ms === "number" && Number.isFinite(rec.ts_ms) ? Math.trunc(rec.ts_ms) : null;
					const eventType = nonEmptyString(rec.event_type);
					const commandId = nonEmptyString(command.command_id);
					const targetType = nonEmptyString(command.target_type);
					const state = nonEmptyString(command.state);
					if (ts == null || !eventType || !commandId || !targetType || !state) {
						continue;
					}
					operatorLifecycleRows.push({
						ts_ms: ts,
						event_type: eventType,
						command_id: commandId,
						target_type: targetType,
						state,
						error_code: nonEmptyString(command.error_code) ?? null,
						operator_session_id: sessionId,
						operator_turn_id: nonEmptyString(command.operator_turn_id) ?? null,
					});
				}
			} catch (err) {
				return jsonError(`failed to read command journal: ${describeError(err)}`, {
					pretty,
					recovery: ["mu control diagnose-operator --json --pretty"],
				});
			}
		}

		operatorLifecycleRows.sort((a, b) => a.ts_ms - b.ts_ms);
		const recentOperatorLifecycle = operatorLifecycleRows
			.slice(-limit)
			.reverse()
			.map((row) => ({
				ts_ms: row.ts_ms,
				ts_iso: formatTs(row.ts_ms),
				event_type: row.event_type,
				command_id: row.command_id,
				target_type: row.target_type,
				state: row.state,
				error_code: row.error_code,
				operator_session_id: row.operator_session_id,
				operator_turn_id: row.operator_turn_id,
			}));

		const payload = {
			repo_root: ctx.repoRoot,
			operator_turn_audit: {
				path: turnsPath,
				exists: turnsExists,
				total: turns.length,
				outcomes: outcomeCounts,
				recent_problematic: problematicTurns,
				recent_turns: recentTurns,
			},
			command_journal: {
				path: paths.commandsPath,
				operator_lifecycle_events: operatorLifecycleRows.length,
				recent_operator_lifecycle: recentOperatorLifecycle,
			},
			hints: [
				!turnsExists
					? "operator_turns.jsonl is missing. This usually means your running mu build predates operator turn auditing; upgrade and restart `mu serve`."
					: null,
				problematicTurns.length > 0
					? "Recent invalid_directive/error outcomes detected. Inspect operator_turns.jsonl for failed command tool calls."
					: null,
			].filter((line): line is string => line != null),
		};

		if (jsonMode) {
			return ok(jsonText(payload, pretty));
		}

		let out = `Operator diagnostics for ${ctx.repoRoot}\n`;
		out += `Audit file: ${turnsPath}\n`;
		out += `Audit exists: ${turnsExists}\n`;
		if (turnsExists) {
			out += `Turns: ${turns.length}\n`;
			const outcomes = Object.entries(outcomeCounts)
				.sort((a, b) => a[0].localeCompare(b[0]))
				.map(([k, v]) => `${k}=${v}`)
				.join(", ");
			out += `Outcomes: ${outcomes || "(none)"}\n`;
		}

		if (problematicTurns.length > 0) {
			out += "\nRecent problematic turns:\n";
			for (const t of problematicTurns) {
				out += `  ${t.ts_iso} req=${t.request_id} outcome=${t.outcome} reason=${t.reason ?? "(none)"}\n`;
			}
		}

		out += `\nOperator lifecycle events in commands journal: ${operatorLifecycleRows.length}\n`;
		if (recentOperatorLifecycle.length > 0) {
			out += "Recent operator lifecycle events:\n";
			for (const row of recentOperatorLifecycle) {
				out += `  ${row.ts_iso} ${row.target_type} ${row.event_type} command=${row.command_id}`;
				if (row.error_code) {
					out += ` error=${row.error_code}`;
				}
				out += "\n";
			}
		}

		if (payload.hints.length > 0) {
			out += "\nHints:\n";
			for (const hint of payload.hints) {
				out += `  - ${hint}\n`;
			}
		}

		return ok(out);
	}

	async function controlLink(argv: string[], ctx: Ctx, pretty: boolean): Promise<ControlCommandRunResult> {
		if (hasHelpFlag(argv)) {
			return ok(
				[
					"mu control link - link a channel identity",
					"",
					"Usage:",
					"  mu control link --channel <slack|discord|telegram> --actor-id <ID> --tenant-id <ID>",
					"    [--operator-id ID] [--role <operator|viewer|contributor>] [--scope SCOPE]",
					"    [--binding-id ID] [--pretty]",
					"",
					"Roles (default: operator):",
					"  operator      Full access (read, write, admin)",
					"  contributor   Read + write (no admin)",
					"  viewer        Read-only",
					"",
					"Examples:",
					"  mu control link --channel telegram --actor-id <chat-id> --tenant-id telegram-bot",
					"  mu control link --channel slack --actor-id U123 --tenant-id T123 --role contributor",
					"  mu control link --channel discord --actor-id <user-id> --tenant-id <guild-id> --scope issue:write",
				].join("\n") + "\n",
			);
		}

		const { value: channel, rest: argv0 } = getFlagValue(argv, "--channel");
		const { value: actorId, rest: argv1 } = getFlagValue(argv0, "--actor-id");
		const { value: tenantId, rest: argv2 } = getFlagValue(argv1, "--tenant-id");
		const { value: operatorId, rest: argv3 } = getFlagValue(argv2, "--operator-id");
		const { value: role, rest: argv4 } = getFlagValue(argv3, "--role");
		const { values: extraScopes, rest: argv5 } = getRepeatFlagValues(argv4, ["--scope"]);
		const { value: bindingIdFlag, rest } = getFlagValue(argv5, "--binding-id");

		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu control link --help"] });
		}

		if (!channel) {
			return jsonError("missing --channel", { pretty, recovery: ["mu control link --help"] });
		}
		if (channel !== "slack" && channel !== "discord" && channel !== "telegram") {
			return jsonError(`invalid channel: ${channel} (slack, discord, telegram)`, {
				pretty,
				recovery: ["mu control link --channel telegram --actor-id 123 --tenant-id telegram-bot"],
			});
		}
		if (!actorId) {
			return jsonError("missing --actor-id", { pretty, recovery: ["mu control link --help"] });
		}
		if (!tenantId) {
			return jsonError("missing --tenant-id", { pretty, recovery: ["mu control link --help"] });
		}

		// Lazy-import control-plane.
		const { IdentityStore, getControlPlanePaths, ROLE_SCOPES } = await import("@femtomc/mu-control-plane");

		const roleKey = role ?? "operator";
		const roleScopes = ROLE_SCOPES[roleKey];
		if (!roleScopes) {
			return jsonError(`invalid role: ${roleKey} (operator, contributor, viewer)`, {
				pretty,
				recovery: ["mu control link --help"],
			});
		}
		const scopes = [...new Set([...roleScopes, ...extraScopes])];

		const bindingId = bindingIdFlag || `bind-${crypto.randomUUID()}`;
		const opId = operatorId || "default";
		const paths = getControlPlanePaths(ctx.repoRoot);
		const store = new IdentityStore(paths.identitiesPath);

		const decision = await store.link({
			bindingId,
			operatorId: opId,
			channel,
			channelTenantId: tenantId,
			channelActorId: actorId,
			scopes,
		});

		switch (decision.kind) {
			case "linked":
				return ok(jsonText({ ok: true, kind: "linked", binding: decision.binding }, pretty));
			case "binding_exists":
				return jsonError(`binding already exists: ${decision.binding.binding_id}`, {
					pretty,
					recovery: ["mu control identities --pretty"],
				});
			case "principal_already_linked":
				return jsonError(
					`principal already linked as ${decision.binding.binding_id} (${decision.binding.channel}/${decision.binding.channel_tenant_id}/${decision.binding.channel_actor_id})`,
					{
						pretty,
						recovery: [`mu control unlink ${decision.binding.binding_id}`, "mu control identities --pretty"],
					},
				);
			default: {
				const _exhaustive: never = decision;
				throw new Error(`unexpected link decision: ${(_exhaustive as any).kind}`);
			}
		}
	}

	async function controlUnlink(argv: string[], ctx: Ctx, pretty: boolean): Promise<ControlCommandRunResult> {
		if (argv.length === 0 || hasHelpFlag(argv)) {
			return ok(
				[
					"mu control unlink - remove an identity binding",
					"",
					"Usage:",
					"  mu control unlink <binding-id> [--revoke] [--reason TEXT] [--pretty]",
					"",
					"Without --revoke: self-unlink (binding acts on itself).",
					"With --revoke: admin revocation (synthetic cli-admin actor).",
					"",
					"Examples:",
					"  mu control unlink bind-abc123",
					"  mu control unlink bind-abc123 --revoke --reason \"offboarded\"",
				].join("\n") + "\n",
			);
		}

		const bindingId = argv[0]!;
		const { present: revoke, rest: argv0 } = popFlag(argv.slice(1), "--revoke");
		const { value: reason, rest } = getFlagValue(argv0, "--reason");

		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu control unlink --help"] });
		}

		const { IdentityStore, getControlPlanePaths } = await import("@femtomc/mu-control-plane");
		const paths = getControlPlanePaths(ctx.repoRoot);
		const store = new IdentityStore(paths.identitiesPath);

		if (revoke) {
			const decision = await store.revoke({
				bindingId,
				actorBindingId: "cli-admin",
				reason: reason ?? null,
			});

			switch (decision.kind) {
				case "revoked":
					return ok(jsonText({ ok: true, kind: "revoked", binding: decision.binding }, pretty));
				case "not_found":
					return jsonError(`binding not found: ${bindingId}`, {
						pretty,
						recovery: ["mu control identities --all --pretty"],
					});
				case "already_inactive":
					return jsonError(`binding already inactive (status=${decision.binding.status})`, {
						pretty,
						recovery: ["mu control identities --all --pretty"],
					});
				default: {
					const _exhaustive: never = decision;
					throw new Error(`unexpected revoke decision: ${(_exhaustive as any).kind}`);
				}
			}
		}

		const decision = await store.unlinkSelf({
			bindingId,
			actorBindingId: bindingId,
			reason: reason ?? null,
		});

		switch (decision.kind) {
			case "unlinked":
				return ok(jsonText({ ok: true, kind: "unlinked", binding: decision.binding }, pretty));
			case "not_found":
				return jsonError(`binding not found: ${bindingId}`, {
					pretty,
					recovery: ["mu control identities --all --pretty"],
				});
			case "invalid_actor":
				return jsonError("self-unlink failed (actor mismatch)", {
					pretty,
					recovery: [`mu control unlink ${bindingId} --revoke`],
				});
			case "already_inactive":
				return jsonError(`binding already inactive (status=${decision.binding.status})`, {
					pretty,
					recovery: ["mu control identities --all --pretty"],
				});
			default: {
				const _exhaustive: never = decision;
				throw new Error(`unexpected unlink decision: ${(_exhaustive as any).kind}`);
			}
		}
	}

	async function controlIdentities(argv: string[], ctx: Ctx, pretty: boolean): Promise<ControlCommandRunResult> {
		if (hasHelpFlag(argv)) {
			return ok(
				[
					"mu control identities - list identity bindings",
					"",
					"Usage:",
					"  mu control identities [--all] [--pretty]",
					"",
					"By default shows active bindings. Use --all to include inactive.",
					"",
					"Examples:",
					"  mu control identities",
					"  mu control identities --all --pretty",
				].join("\n") + "\n",
			);
		}

		const { present: all, rest } = popFlag(argv, "--all");
		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu control identities --help"] });
		}

		const { IdentityStore, getControlPlanePaths } = await import("@femtomc/mu-control-plane");
		const paths = getControlPlanePaths(ctx.repoRoot);
		const store = new IdentityStore(paths.identitiesPath);
		await store.load();

		const bindings = store.listBindings({ includeInactive: all });
		return ok(jsonText(bindings, pretty));
	}

	async function controlStatus(argv: string[], ctx: Ctx, pretty: boolean): Promise<ControlCommandRunResult> {
		if (hasHelpFlag(argv)) {
			return ok(
				[
					"mu control status - show control-plane readiness snapshot",
					"",
					"Usage:",
					"  mu control status [--json] [--pretty] [--verbose|--debug]",
					"",
					"Includes:",
					"  identity binding counts, adapter config presence, operator defaults, config/policy paths",
					"",
					"Examples:",
					"  mu control status",
					"  mu control status --verbose",
					"  mu control status --json --pretty",
				].join("\n") + "\n",
			);
		}

		const { present: jsonMode, rest: argv0 } = popFlag(argv, "--json");
		const { present: verbose, rest: argv1 } = popFlag(argv0, "--verbose");
		const { present: debug, rest } = popFlag(argv1, "--debug");
		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu control status --help"] });
		}

		const { IdentityStore, getControlPlanePaths } = await import("@femtomc/mu-control-plane");
		const paths = getControlPlanePaths(ctx.repoRoot);
		const store = new IdentityStore(paths.identitiesPath);
		await store.load();

		const bindings = store.listBindings();
		const allBindings = store.listBindings({ includeInactive: true });
		const hasPolicyFile = await fileExists(paths.policyPath);

		const configPath = storePathForRepoRoot(ctx.repoRoot, "config.json");
		let config: Record<string, unknown> = {};
		try {
			const raw = await Bun.file(configPath).text();
			config = JSON.parse(raw) as Record<string, unknown>;
		} catch (err) {
			const code = (err as { code?: string })?.code;
			if (code !== "ENOENT") {
				return ok(`failed to read ${configPath}: ${describeError(err)}`, 1);
			}
		}

		const controlPlane = (config.control_plane as Record<string, unknown> | undefined) ?? {};
		const adaptersCfg = (controlPlane.adapters as Record<string, unknown> | undefined) ?? {};
		const slackCfg = (adaptersCfg.slack as Record<string, unknown> | undefined) ?? {};
		const discordCfg = (adaptersCfg.discord as Record<string, unknown> | undefined) ?? {};
		const telegramCfg = (adaptersCfg.telegram as Record<string, unknown> | undefined) ?? {};
		const neovimCfg = (adaptersCfg.neovim as Record<string, unknown> | undefined) ?? {};
		const operatorCfg = (controlPlane.operator as Record<string, unknown> | undefined) ?? {};

		const present = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0;
		const boolOr = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);
		const strOrNull = (value: unknown): string | null =>
			typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
		const intOr = (value: unknown, fallback: number): number =>
			typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;

		const adapters: { channel: string; configured: boolean }[] = [
			{ channel: "slack", configured: present(slackCfg.signing_secret) },
			{ channel: "discord", configured: present(discordCfg.signing_secret) },
			{ channel: "telegram", configured: present(telegramCfg.webhook_secret) },
			{ channel: "neovim", configured: present(neovimCfg.shared_secret) },
		];

		const operator = {
			enabled: boolOr(operatorCfg.enabled, true),
			provider: strOrNull(operatorCfg.provider),
			model: strOrNull(operatorCfg.model),
			thinking: strOrNull(operatorCfg.thinking),
			timeout_ms: intOr(operatorCfg.timeout_ms, 600_000),
		};

		const payload = {
			repo_root: ctx.repoRoot,
			identities: {
				active: bindings.length,
				total: allBindings.length,
			},
			policy: {
				path: paths.policyPath,
				exists: hasPolicyFile,
			},
			adapters,
			operator: operator,
			config_path: configPath,
		};

		if (jsonMode) {
			return ok(jsonText(payload, pretty));
		}

		const showDetails = verbose || debug;
		if (!showDetails) {
			const adapterSummary = adapters.map((adapter) => `${adapter.channel}=${adapter.configured ? "yes" : "no"}`).join(", ");
			let out = `Control plane: ${ctx.repoRoot}\n`;
			out += `Identities: ${bindings.length} active, ${allBindings.length} total\n`;
			out += `Policy: ${hasPolicyFile ? "configured" : "missing"}\n`;
			out += `Adapters: ${adapterSummary}\n`;
			out += `Operator: enabled=${operator.enabled} provider=${operator.provider ?? "(default)"} model=${operator.model ?? "(default)"} thinking=${operator.thinking ?? "(default)"}\n`;
			out += `Config: ${configPath}\n`;
			out += "Use `mu control status --verbose` for detailed adapter/operator breakdown.\n";
			return ok(out);
		}

		let out = `Control plane: ${ctx.repoRoot}\n`;
		out += `Identities: ${bindings.length} active, ${allBindings.length} total\n`;
		out += `Policy: ${hasPolicyFile ? paths.policyPath : "(none)"}\n`;
		out += `Config: ${configPath}\n`;
		out += "\nAdapter config:\n";
		for (const a of adapters) {
			const status = a.configured ? "configured" : "not configured";
			out += `  ${a.channel.padEnd(12)} ${status}\n`;
		}
		out += "\nOperator config:\n";
		out += `  enabled              ${operator.enabled}\n`;
		out += `  provider             ${operator.provider ?? "(default)"}\n`;
		out += `  model                ${operator.model ?? "(default)"}\n`;
		out += `  thinking             ${operator.thinking ?? "(default)"}\n`;
		out += `  timeout_ms           ${operator.timeout_ms}\n`;
		out += "  Use `mu serve` for direct terminal operator access.\n";

		return ok(out);
	}

	async function controlHarness(argv: string[], ctx: Ctx, pretty: boolean): Promise<ControlCommandRunResult> {
		if (hasHelpFlag(argv)) {
			return ok(
				[
					"mu control harness - show harness adapter/provider/model capabilities",
					"",
					"Usage:",
					"  mu control harness [provider] [--json] [--pretty] [--verbose|--debug]",
					"",
					"Includes:",
					"  adapter config presence, operator defaults, provider auth, model capability vectors",
					"",
					"Examples:",
					"  mu control harness",
					"  mu control harness --verbose",
					"  mu control harness anthropic",
					"  mu control harness openai-codex --json --pretty",
				].join("\n") + "\n",
			);
		}

		const { present: jsonMode, rest: argv0 } = popFlag(argv, "--json");
		const { present: verbose, rest: argv1 } = popFlag(argv0, "--verbose");
		const { present: debug, rest: argv2 } = popFlag(argv1, "--debug");
		if (argv2.length > 1) {
			return jsonError(`unknown args: ${argv2.join(" ")}`, {
				pretty,
				recovery: ["mu control harness --help"],
			});
		}

		const providerFilterRaw = argv2[0]?.trim();
		const { readMuConfigFile, getMuConfigPath } = await import("@femtomc/mu-server");
		const { getModels, getProviders, supportsXhigh } = await import("@mariozechner/pi-ai");
		const { AuthStorage } = await import("@mariozechner/pi-coding-agent");

		const config = await readMuConfigFile(ctx.repoRoot);
		const configPath = getMuConfigPath(ctx.repoRoot);
		const providers = getProviders().map((provider) => String(provider));
		const authStorage = AuthStorage.create();

		const lookupProvider = (providerRaw: string): string | null => {
			const trimmed = providerRaw.trim();
			if (!isSafeOperatorToken(trimmed)) {
				return null;
			}
			const found = providers.find((provider) => provider === trimmed);
			return found ?? null;
		};

		let providerFilter: string | null = null;
		if (providerFilterRaw) {
			providerFilter = lookupProvider(providerFilterRaw);
			if (!providerFilter) {
				return jsonError(`unknown provider: ${providerFilterRaw}`, {
					pretty,
					recovery: ["mu control operator models"],
				});
			}
		}

		const listProviderModels = (provider: string) =>
			getModels(provider as never).map((model) => {
				const xhigh = supportsXhigh(model);
				const reasoning = Boolean(model.reasoning);
				const thinkingLevels = supportedThinkingLevelsForModel({ reasoning, xhigh });
				return {
					id: model.id,
					api: String(model.api),
					reasoning,
					xhigh,
					thinking_levels: thinkingLevels,
					input: [...model.input].map((entry) => String(entry)),
					context_window: model.contextWindow,
					max_tokens: model.maxTokens,
					cost: {
						input: model.cost.input,
						output: model.cost.output,
						cache_read: model.cost.cacheRead,
						cache_write: model.cost.cacheWrite,
					},
				};
			});

		const buildProviderCatalog = (providerNames: readonly string[]) =>
			providerNames.map((provider) => {
				const models = listProviderModels(provider);
				const apiFamilies = [...new Set(models.map((model) => model.api))].sort((a, b) => a.localeCompare(b));
				const inputModalities = [...new Set(models.flatMap((model) => model.input))].sort((a, b) => a.localeCompare(b));
				return {
					provider,
					authenticated: authStorage.hasAuth(provider),
					model_count: models.length,
					reasoning_model_count: models.filter((model) => model.reasoning).length,
					xhigh_model_count: models.filter((model) => model.xhigh).length,
					api_families: apiFamilies,
					input_modalities: inputModalities,
					models,
				};
			});

		const allProviders = buildProviderCatalog(providers);
		const selectedProviders = providerFilter
			? allProviders.filter((provider) => provider.provider === providerFilter)
			: allProviders;

		const configuredProvider = config.control_plane.operator.provider;
		const configuredModel = config.control_plane.operator.model;
		const configuredProviderEntry = configuredProvider
			? allProviders.find((provider) => provider.provider === configuredProvider)
			: null;
		const configuredModelEntry =
			configuredProviderEntry && configuredModel
				? configuredProviderEntry.models.find((model) => model.id === configuredModel)
				: null;

		const defaultModel = configuredProvider
			? {
					provider: configuredProvider,
					model: configuredModel,
					resolved: configuredModelEntry != null,
					reason:
						configuredModelEntry != null
							? null
							: configuredProviderEntry == null
								? "provider_not_in_pi_registry"
								: "model_not_in_provider_catalog",
					capabilities: configuredModelEntry,
				}
			: null;

		const adapters = [
			{
				channel: "slack",
				configured: config.control_plane.adapters.slack.signing_secret != null,
				bot_token_configured: config.control_plane.adapters.slack.bot_token != null,
			},
			{
				channel: "discord",
				configured: config.control_plane.adapters.discord.signing_secret != null,
			},
			{
				channel: "telegram",
				configured: config.control_plane.adapters.telegram.webhook_secret != null,
				bot_token_configured: config.control_plane.adapters.telegram.bot_token != null,
			},
			{
				channel: "neovim",
				configured: config.control_plane.adapters.neovim.shared_secret != null,
			},
		];

		const authenticatedProviders = allProviders
			.filter((provider) => provider.authenticated)
			.map((provider) => provider.provider);
		const authenticatedApiFamilies = [
			...new Set(
				allProviders
					.filter((provider) => provider.authenticated)
					.flatMap((provider) => provider.api_families),
			),
		].sort((a, b) => a.localeCompare(b));

		const payload = {
			repo_root: ctx.repoRoot,
			config_path: configPath,
			adapters,
			operator_defaults: {
				enabled: config.control_plane.operator.enabled,
				provider: config.control_plane.operator.provider,
				model: config.control_plane.operator.model,
				thinking: config.control_plane.operator.thinking,
				timeout_ms: config.control_plane.operator.timeout_ms,
			},
			authenticated_ai: {
				providers: authenticatedProviders,
				api_families: authenticatedApiFamilies,
			},
			provider_filter: providerFilter,
			providers: selectedProviders,
			default_model: defaultModel,
		};

		if (jsonMode) {
			return ok(jsonText(payload, pretty));
		}

		const showDetails = verbose || debug;
		if (!showDetails) {
			const adapterSummary = adapters
				.map((adapter) => {
					const base = `${adapter.channel}=${adapter.configured ? "yes" : "no"}`;
					if ("bot_token_configured" in adapter) {
						return `${base}(bot=${adapter.bot_token_configured ? "yes" : "no"})`;
					}
					return base;
				})
				.join(", ");
			const providerSummary = selectedProviders
				.map(
					(provider) =>
						`${provider.provider}(auth=${provider.authenticated ? "yes" : "no"}, models=${provider.model_count}, reasoning=${provider.reasoning_model_count}, xhigh=${provider.xhigh_model_count})`,
				)
				.join("; ");

			let out = `Harness: ${ctx.repoRoot}\n`;
			out += `Config: ${configPath}\n`;
			out += `Adapters: ${adapterSummary}\n`;
			out += `Operator defaults: enabled=${payload.operator_defaults.enabled} provider=${payload.operator_defaults.provider ?? "(default)"} model=${payload.operator_defaults.model ?? "(default)"} thinking=${payload.operator_defaults.thinking ?? "(default)"} timeout_ms=${payload.operator_defaults.timeout_ms}\n`;
			out += `Authenticated AI providers: ${authenticatedProviders.length > 0 ? authenticatedProviders.join(", ") : "(none)"}\n`;
			if (authenticatedApiFamilies.length > 0) {
				out += `Authenticated APIs: ${authenticatedApiFamilies.join(", ")}\n`;
			}
			out += `Providers: ${providerSummary || "(none)"}\n`;

			if (defaultModel == null) {
				out += "Default model: (not configured)\n";
			} else if (!defaultModel.resolved) {
				out += `Default model: ${defaultModel.provider}/${defaultModel.model ?? "(missing)"} (unresolved: ${defaultModel.reason})\n`;
			} else if (defaultModel.capabilities) {
				const model = defaultModel.capabilities;
				out += `Default model: ${model.id} [api=${model.api}, reasoning=${model.reasoning ? "yes" : "no"}, xhigh=${model.xhigh ? "yes" : "no"}]\n`;
			}

			if (providerFilter && selectedProviders.length > 0) {
				const provider = selectedProviders[0]!;
				const modelIds = provider.models.map((model) => model.id);
				const shown = modelIds.slice(0, 20);
				const hiddenCount = modelIds.length - shown.length;
				out += `Models (${modelIds.length}) for ${provider.provider}: ${shown.join(", ")}${hiddenCount > 0 ? `, +${hiddenCount} more` : ""}\n`;
				out += "Use `mu control harness --verbose` (or --json --pretty) for per-model capability vectors.\n";
			} else {
				out += "Use `mu control harness --verbose` (or <provider> --json --pretty) for full capability vectors.\n";
			}
			return ok(out);
		}

		let out = `Harness: ${ctx.repoRoot}\n`;
		out += `Config: ${configPath}\n`;
		out += "\nMessaging adapters:\n";
		for (const adapter of adapters) {
			const extra = "bot_token_configured" in adapter ? `, bot_token=${adapter.bot_token_configured ? "yes" : "no"}` : "";
			out += `  ${adapter.channel.padEnd(12)} configured=${adapter.configured ? "yes" : "no"}${extra}\n`;
		}

		out += "\nOperator defaults:\n";
		out += `  enabled              ${payload.operator_defaults.enabled}\n`;
		out += `  provider             ${payload.operator_defaults.provider ?? "(default)"}\n`;
		out += `  model                ${payload.operator_defaults.model ?? "(default)"}\n`;
		out += `  thinking             ${payload.operator_defaults.thinking ?? "(default)"}\n`;
		out += `  timeout_ms           ${payload.operator_defaults.timeout_ms}\n`;

		out += "\nAuthenticated AI providers:\n";
		if (authenticatedProviders.length === 0) {
			out += "  (none)\n";
		} else {
			for (const provider of authenticatedProviders) {
				out += `  - ${provider}\n`;
			}
			out += `  APIs: ${authenticatedApiFamilies.join(", ")}\n`;
		}

		out += "\nProvider catalog:\n";
		for (const provider of selectedProviders) {
			const apis = provider.api_families.join(",") || "(none)";
			const inputs = provider.input_modalities.join(",") || "(none)";
			out += `  ${provider.provider.padEnd(18)} auth=${provider.authenticated ? "yes" : "no"} models=${provider.model_count} reasoning=${provider.reasoning_model_count} xhigh=${provider.xhigh_model_count} apis=${apis} input=${inputs}\n`;
		}

		if (defaultModel == null) {
			out += "\nDefault model: (not configured)\n";
		} else if (!defaultModel.resolved) {
			out += `\nDefault model: ${defaultModel.provider}/${defaultModel.model ?? "(missing)"} (unresolved: ${defaultModel.reason})\n`;
		} else if (defaultModel.capabilities) {
			const model = defaultModel.capabilities;
			out += "\nDefault model capabilities:\n";
			out += `  ${model.id}\n`;
			out += `  api                 ${model.api}\n`;
			out += `  reasoning           ${model.reasoning ? "yes" : "no"}\n`;
			out += `  xhigh               ${model.xhigh ? "yes" : "no"}\n`;
			out += `  thinking_levels     ${model.thinking_levels.join(", ")}\n`;
			out += `  context_window      ${model.context_window}\n`;
			out += `  max_tokens          ${model.max_tokens}\n`;
			out += `  input               ${model.input.join(", ")}\n`;
		}

		if (providerFilter && selectedProviders.length > 0) {
			const provider = selectedProviders[0]!;
			out += `\nModels for provider ${provider.provider}:\n`;
			for (const model of provider.models) {
				out += `  - ${model.id} [api=${model.api}, reasoning=${model.reasoning ? "yes" : "no"}, xhigh=${model.xhigh ? "yes" : "no"}, ctx=${model.context_window}, max=${model.max_tokens}, input=${model.input.join(",")}]\n`;
			}
		} else {
			out += "\nTip: run `mu control harness <provider> --json --pretty` for full per-model capability vectors.\n";
		}

		return ok(out);
	}

	const OPERATOR_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
	type OperatorThinkingLevel = (typeof OPERATOR_THINKING_LEVELS)[number];
	const OPERATOR_THINKING_LEVEL_SET = new Set<string>(OPERATOR_THINKING_LEVELS);

	function normalizeOperatorThinkingLevel(value: string | null | undefined): OperatorThinkingLevel | null {
		if (typeof value !== "string") {
			return null;
		}
		const normalized = value.trim().toLowerCase();
		if (!OPERATOR_THINKING_LEVEL_SET.has(normalized)) {
			return null;
		}
		return normalized as OperatorThinkingLevel;
	}

	function isSafeOperatorToken(value: string): boolean {
		return /^(?!-)[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value);
	}

	function supportedThinkingLevelsForModel(opts: { reasoning: boolean; xhigh: boolean }): OperatorThinkingLevel[] {
		const out: OperatorThinkingLevel[] = ["off", "minimal"];
		if (opts.reasoning) {
			out.push("low", "medium", "high");
		}
		if (opts.xhigh) {
			out.push("xhigh");
		}
		return out;
	}

	async function reloadRunningControlPlane(opts: {
		ctx: Ctx;
		reason: string;
		missingServerMessage: string;
	}): Promise<{
		attempted: boolean;
		ok: boolean;
		message: string;
		payload: Record<string, unknown> | null;
	}> {
		const running = await detectRunningServer(opts.ctx.repoRoot);
		if (!running) {
			return {
				attempted: false,
				ok: false,
				message: opts.missingServerMessage,
				payload: null,
			};
		}

		let response: Response;
		try {
			response = await fetch(`${running.url}/api/control-plane/reload`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ reason: opts.reason }),
				signal: AbortSignal.timeout(10_000),
			});
		} catch (err) {
			return {
				attempted: true,
				ok: false,
				message: `reload request failed: ${describeError(err)}`,
				payload: null,
			};
		}

		let payload: unknown = null;
		try {
			payload = await response.json();
		} catch {
			payload = null;
		}

		if (!response.ok) {
			const detail = await readApiError(response, payload);
			return {
				attempted: true,
				ok: false,
				message: `reload failed: ${detail}`,
				payload: asRecord(payload),
			};
		}

		return {
			attempted: true,
			ok: true,
			message: "control-plane reload applied",
			payload: asRecord(payload),
		};
	}

	async function reloadRunningControlPlaneForOperatorUpdate(ctx: Ctx): Promise<{
		attempted: boolean;
		ok: boolean;
		message: string;
		payload: Record<string, unknown> | null;
	}> {
		return await reloadRunningControlPlane({
			ctx,
			reason: "cli_control_operator_update",
			missingServerMessage: "no running server detected; start `mu serve` to apply immediately",
		});
	}

	async function reloadRunningControlPlaneForConfigUpdate(ctx: Ctx): Promise<{
		attempted: boolean;
		ok: boolean;
		message: string;
		payload: Record<string, unknown> | null;
	}> {
		return await reloadRunningControlPlane({
			ctx,
			reason: "cli_control_config_update",
			missingServerMessage: "no running server detected; start `mu serve` to apply immediately",
		});
	}

	async function controlConfig(argv: string[], ctx: Ctx, pretty: boolean): Promise<ControlCommandRunResult> {
		const renderEntry = (spec: ControlConfigKeySpec, config: Record<string, unknown>) => {
			const raw = readControlConfigPathValue(config, spec.path);
			if (spec.kind === "secret_string") {
				const present = typeof raw === "string" && raw.trim().length > 0;
				return {
					key: spec.key,
					type: "string",
					secret: true,
					description: spec.description,
					default_value: null,
					value: null,
					present,
				};
			}

			if (spec.kind === "boolean") {
				const fallback = spec.defaultValue === true;
				const value = typeof raw === "boolean" ? raw : fallback;
				return {
					key: spec.key,
					type: "boolean",
					secret: false,
					description: spec.description,
					default_value: fallback,
					value,
					present: null,
				};
			}

			const fallback = typeof spec.defaultValue === "number" ? spec.defaultValue : 0;
			const value = typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : fallback;
			return {
				key: spec.key,
				type: "integer",
				secret: false,
				description: spec.description,
				default_value: fallback,
				value,
				present: null,
			};
		};

		const renderHelp = (): string => {
			const keyLines = CONTROL_CONFIG_KEY_SPECS.map((spec) => `  - ${buildControlConfigKeySummary(spec)}`);
			return (
				[
					"mu control config - inspect/update workspace control-plane config",
					"",
					"Usage:",
					"  mu control config get [key] [--json] [--pretty] [--verbose|--debug]",
					"  mu control config set <key> <value> [--json] [--pretty]",
					"  mu control config set <key> --value <value> [--json] [--pretty]",
					"  mu control config set <key> --stdin [--json] [--pretty]",
					"  mu control config unset <key> [--json] [--pretty]",
					"",
					"Supported keys:",
					...keyLines,
					"",
					"Notes:",
					"  - Secret keys never echo plaintext values; output reports configured=true/false.",
					"  - get text output is compact by default; --verbose/--debug adds defaults + descriptions.",
					"  - set/unset write workspace config.json and request live reload when server is running.",
					"  - Use --stdin for secrets to avoid shell history/process-list exposure.",
					"",
					"Examples:",
					"  mu control config get",
					"  mu control config get control_plane.operator.timeout_ms",
					"  mu control config set control_plane.operator.enabled false",
					"  mu control config set control_plane.memory_index.every_ms 120000",
					"  printf 'xoxb-...' | mu control config set control_plane.adapters.slack.bot_token --stdin",
					"  mu control config unset control_plane.adapters.slack.bot_token",
				].join("\n") + "\n"
			);
		};

		if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
			return ok(renderHelp());
		}

		const { present: jsonMode, rest: argv0 } = popFlag(argv, "--json");
		const { present: verbose, rest: argv1 } = popFlag(argv0, "--verbose");
		const { present: debug, rest: argv2 } = popFlag(argv1, "--debug");
		if (argv2.length === 0) {
			return jsonError("missing config subcommand", {
				pretty,
				recovery: ["mu control config --help"],
			});
		}

		const sub = argv2[0]!;
		const args = argv2.slice(1);
		const showDetails = verbose || debug;
		if (showDetails && sub !== "get") {
			return jsonError("--verbose/--debug are only supported with `mu control config get`", {
				pretty,
				recovery: ["mu control config get --verbose"],
			});
		}
		const { readMuConfigFile, writeMuConfigFile, applyMuConfigPatch, getMuConfigPath } = await import("@femtomc/mu-server");
		const resolveSpec = (keyRaw: string): ControlConfigKeySpec | null => {
			const key = keyRaw.trim();
			if (!key) {
				return null;
			}
			return CONTROL_CONFIG_KEY_BY_NAME.get(key) ?? null;
		};

		if (sub === "get") {
			if (hasHelpFlag(args)) {
				return ok(renderHelp());
			}
			if (args.length > 1) {
				return jsonError(`unknown args: ${args.join(" ")}`, {
					pretty,
					recovery: ["mu control config --help"],
				});
			}

			const spec = args[0] ? resolveSpec(args[0]) : null;
			if (args[0] && !spec) {
				return jsonError(`unknown config key: ${args[0]}`, {
					pretty,
					recovery: ["mu control config get", "mu control config --help"],
				});
			}

			const config = asRecord(await readMuConfigFile(ctx.repoRoot)) ?? {};
			const configPath = getMuConfigPath(ctx.repoRoot);
			const selected = spec ? [spec] : [...CONTROL_CONFIG_KEY_SPECS];
			const entries = selected.map((entry) => renderEntry(entry, config));

			const payload = {
				repo_root: ctx.repoRoot,
				config_path: configPath,
				scope: "workspace",
				action: "get",
				count: entries.length,
				entries,
			};
			if (jsonMode) {
				return ok(jsonText(payload, pretty));
			}

			let out = `Workspace control config (${entries.length})\n`;
			out += `Config: ${configPath}\n\n`;
			for (const entry of entries) {
				if (!showDetails) {
					if (entry.secret) {
						out += `  ${entry.key} configured=${entry.present ? "yes" : "no"}\n`;
					} else {
						out += `  ${entry.key} value=${String(entry.value)}\n`;
					}
					continue;
				}
				if (entry.secret) {
					out += `  ${entry.key}\n`;
					out += `    configured         ${entry.present ? "yes" : "no"}\n`;
					out += `    description        ${entry.description}\n`;
					continue;
				}
				out += `  ${entry.key}\n`;
				out += `    value              ${String(entry.value)}\n`;
				out += `    default            ${String(entry.default_value)}\n`;
				out += `    description        ${entry.description}\n`;
			}
			if (!showDetails && entries.length > 1) {
				out += "\nUse `mu control config get --verbose` for defaults + descriptions.\n";
			}
			return ok(out);
		}

		if (sub === "set") {
			if (hasHelpFlag(args)) {
				return ok(renderHelp());
			}

			const { present: stdinMode, rest: argv1 } = popFlag(args, "--stdin");
			const { value: valueFlag, rest: argv2 } = getFlagValue(argv1, "--value");
			if (argv2.length < 1 || argv2.length > 2) {
				return jsonError("usage: mu control config set <key> <value> | --value <value> | --stdin", {
					pretty,
					recovery: ["mu control config --help"],
				});
			}

			const spec = resolveSpec(argv2[0]!);
			if (!spec) {
				return jsonError(`unknown config key: ${argv2[0]}`, {
					pretty,
					recovery: ["mu control config get", "mu control config --help"],
				});
			}

			const valuePositional = argv2[1] ?? null;
			if (stdinMode && (valueFlag != null || valuePositional != null)) {
				return jsonError("--stdin cannot be combined with positional value or --value", {
					pretty,
					recovery: ["mu control config set <key> --stdin"],
				});
			}
			if (valueFlag != null && valuePositional != null) {
				return jsonError("provide either positional value or --value, not both", {
					pretty,
					recovery: ["mu control config set <key> <value>"],
				});
			}

			let rawValue: string;
			if (stdinMode) {
				rawValue = trimSingleTrailingNewline(await Bun.stdin.text());
			} else {
				const candidate = valueFlag ?? valuePositional;
				if (candidate == null) {
					return jsonError("missing config value (or use --stdin)", {
						pretty,
						recovery: ["mu control config set <key> <value>", "mu control config set <key> --stdin"],
					});
				}
				rawValue = candidate;
			}

			let value: string | number | boolean;
			if (spec.kind === "secret_string") {
				const normalized = rawValue.trim();
				if (normalized.length === 0) {
					return jsonError(`empty value for ${spec.key}; use unset to clear`, {
						pretty,
						recovery: [`mu control config unset ${spec.key}`],
					});
				}
				value = normalized;
			} else if (spec.kind === "boolean") {
				const parsed = parseControlConfigBoolean(rawValue);
				if (parsed == null) {
					return jsonError(`invalid boolean for ${spec.key}: ${JSON.stringify(rawValue)}`, {
						pretty,
						recovery: ["valid booleans: true,false,1,0,yes,no,on,off"],
					});
				}
				value = parsed;
			} else {
				const parsed = ensureInt(rawValue, {
					name: spec.key,
					min: spec.min,
					max: spec.max,
				});
				if (parsed == null) {
					const range = spec.min != null && spec.max != null ? `${spec.min}-${spec.max}` : "a valid integer";
					return jsonError(`invalid integer for ${spec.key}; expected ${range}`, {
						pretty,
						recovery: [`mu control config get ${spec.key}`],
					});
				}
				value = parsed;
			}

			const current = await readMuConfigFile(ctx.repoRoot);
			const next = applyMuConfigPatch(current, buildControlConfigPatch(spec.path, value));
			const configPath = await writeMuConfigFile(ctx.repoRoot, next);
			const reload = await reloadRunningControlPlaneForConfigUpdate(ctx);
			const entry = renderEntry(spec, asRecord(next) ?? {});
			const payload = {
				ok: true,
				scope: "workspace",
				action: "set",
				config_path: configPath,
				entry,
				reload,
			};
			if (jsonMode) {
				return ok(jsonText(payload, pretty));
			}

			let out = `Workspace control config updated in ${configPath}\n`;
			out += `  key      ${entry.key}\n`;
			if (entry.secret) {
				out += `  value    (redacted)\n`;
				out += `  present  ${entry.present ? "yes" : "no"}\n`;
			} else {
				out += `  value    ${String(entry.value)}\n`;
			}
			out += `  reload   ${reload.message}\n`;
			return ok(out);
		}

		if (sub === "unset") {
			if (hasHelpFlag(args)) {
				return ok(renderHelp());
			}
			if (args.length !== 1) {
				return jsonError("usage: mu control config unset <key>", {
					pretty,
					recovery: ["mu control config --help"],
				});
			}

			const spec = resolveSpec(args[0]!);
			if (!spec) {
				return jsonError(`unknown config key: ${args[0]}`, {
					pretty,
					recovery: ["mu control config get", "mu control config --help"],
				});
			}

			const resetValue = spec.kind === "secret_string" ? null : spec.defaultValue;
			const current = await readMuConfigFile(ctx.repoRoot);
			const next = applyMuConfigPatch(current, buildControlConfigPatch(spec.path, resetValue));
			const configPath = await writeMuConfigFile(ctx.repoRoot, next);
			const reload = await reloadRunningControlPlaneForConfigUpdate(ctx);
			const entry = renderEntry(spec, asRecord(next) ?? {});
			const payload = {
				ok: true,
				scope: "workspace",
				action: "unset",
				config_path: configPath,
				entry,
				reload,
			};
			if (jsonMode) {
				return ok(jsonText(payload, pretty));
			}

			let out = `Workspace control config unset in ${configPath}\n`;
			out += `  key      ${entry.key}\n`;
			if (entry.secret) {
				out += `  present  ${entry.present ? "yes" : "no"}\n`;
			} else {
				out += `  value    ${String(entry.value)}\n`;
				out += `  default  ${String(entry.default_value)}\n`;
			}
			out += `  reload   ${reload.message}\n`;
			return ok(out);
		}

		return jsonError(`unknown config subcommand: ${sub}`, {
			pretty,
			recovery: ["mu control config --help"],
		});
	}

	async function controlUiState(argv: string[], ctx: Ctx, pretty: boolean): Promise<ControlCommandRunResult> {
		if (hasHelpFlag(argv)) {
			return ok(
				[
					"mu control ui-state - inspect persisted UiDoc scope/revision state",
					"",
					"Usage:",
					"  mu control ui-state [list] [--kind session|conversation] [--limit N] [--json] [--pretty] [--verbose|--debug]",
					"  mu control ui-state get <session|conversation> <scope-id> [--json] [--pretty] [--verbose|--debug]",
					"  mu control ui-state get --kind <session|conversation> --id <scope-id> [--json] [--pretty] [--verbose|--debug]",
					"",
					"Notes:",
					"  - Reads <store>/control-plane/ui_docs_state.jsonl",
					"  - list defaults to compact output; use --verbose for ui_id + writer detail",
					"",
					"Examples:",
					"  mu control ui-state",
					"  mu control ui-state list --kind session --limit 50",
					"  mu control ui-state get session heartbeat-program:hb-123",
					"  mu control ui-state get --kind conversation --id slack:team:chan:binding",
				].join("\n") + "\n",
			);
		}

		const { present: jsonMode, rest: argv0 } = popFlag(argv, "--json");
		const { present: verbose, rest: argv1 } = popFlag(argv0, "--verbose");
		const { present: debug, rest: argv2 } = popFlag(argv1, "--debug");
		const showDetails = verbose || debug;

		const firstToken = argv2[0] ?? null;
		const implicitList = firstToken == null || firstToken.startsWith("--");
		const sub = implicitList ? "list" : firstToken;
		const args = implicitList ? argv2 : argv2.slice(1);

		const { UiDocsStateStore, getControlPlanePaths } = await import("@femtomc/mu-control-plane");
		const paths = getControlPlanePaths(ctx.repoRoot);
		const statePath = join(paths.controlPlaneDir, "ui_docs_state.jsonl");
		const store = new UiDocsStateStore(statePath);
		await store.load();

		if (sub === "list") {
			const { value: kindRaw, rest: argv3 } = getFlagValue(args, "--kind");
			const { value: limitRaw, rest } = getFlagValue(argv3, "--limit");
			if (rest.length > 0) {
				return jsonError(`unknown args: ${rest.join(" ")}`, {
					pretty,
					recovery: ["mu control ui-state --help"],
				});
			}

			const kindFilter =
				kindRaw == null ? null : normalizeUiStateScopeKind(kindRaw) ?? null;
			if (kindRaw != null && !kindFilter) {
				return jsonError(`invalid --kind: ${kindRaw} (session|conversation)`, {
					pretty,
					recovery: ["mu control ui-state list --kind session"],
				});
			}

			const limit =
				limitRaw == null ? 20 : ensureInt(limitRaw, { name: "--limit", min: 1, max: 500 });
			if (limit == null) {
				return jsonError("limit must be an integer between 1 and 500", {
					pretty,
					recovery: ["mu control ui-state list --limit 20"],
				});
			}

			const records = store.snapshot({ scopeKind: kindFilter ?? undefined, limit });
			const payload = {
				repo_root: ctx.repoRoot,
				store_path: statePath,
				action: "list",
				filters: {
					scope_kind: kindFilter,
					limit,
				},
				count: records.length,
				records,
			};
			if (jsonMode) {
				return ok(jsonText(payload, pretty));
			}

			let out = `UI docs state (${records.length})\n`;
			out += `Store: ${statePath}\n`;
			if (kindFilter) {
				out += `Filter: kind=${kindFilter}\n`;
			}
			if (records.length === 0) {
				out += "No ui-state scopes found.\n";
				return ok(out);
			}

			for (const record of records) {
				out += `  ${isoForTsMs(record.updated_at_ms)} ${record.scope.kind}:${record.scope.id} rev=${record.rev} docs=${record.docs.length} writer=${compactWriterSummary(asRecord(record.writer) ?? {})}\n`;
				if (showDetails) {
					const uiIds = record.docs.map((doc) => doc.ui_id).join(", ");
					if (uiIds.length > 0) {
						out += `      ui_ids: ${uiIds}\n`;
					}
					const writer = asRecord(record.writer) ?? {};
					const writerDetails = [
						typeof writer.channel === "string" && writer.channel.length > 0 ? `channel=${writer.channel}` : null,
						typeof writer.actor_binding_id === "string" && writer.actor_binding_id.length > 0
							? `binding=${writer.actor_binding_id}`
							: null,
						typeof writer.program_id === "string" && writer.program_id.length > 0
							? `program=${writer.program_id}`
							: null,
					]
						.filter((entry): entry is string => entry != null)
						.join(" ");
					if (writerDetails.length > 0) {
						out += `      writer: ${writerDetails}\n`;
					}
				}
			}
			if (!showDetails) {
				out += "Use `mu control ui-state list --verbose` for ui_id + writer detail.\n";
			}
			return ok(out);
		}

		if (sub === "get") {
			const { value: kindFlag, rest: argv3 } = getFlagValue(args, "--kind");
			const { value: idFlag, rest } = getFlagValue(argv3, "--id");
			const usingFlags = kindFlag != null || idFlag != null;
			if (usingFlags && rest.length > 0) {
				return jsonError("cannot mix positional scope args with --kind/--id", {
					pretty,
					recovery: ["mu control ui-state get --kind session --id <scope-id>"],
				});
			}

			let kindRaw: string | null = null;
			let scopeIdRaw: string | null = null;
			if (usingFlags) {
				if (!kindFlag || !idFlag) {
					return jsonError("get requires both --kind and --id", {
						pretty,
						recovery: ["mu control ui-state get --kind session --id <scope-id>"],
					});
				}
				kindRaw = kindFlag;
				scopeIdRaw = idFlag;
			} else {
				if (rest.length !== 2) {
					return jsonError("usage: mu control ui-state get <session|conversation> <scope-id>", {
						pretty,
						recovery: ["mu control ui-state --help"],
					});
				}
				kindRaw = rest[0] ?? null;
				scopeIdRaw = rest[1] ?? null;
			}

			const scopeKind = normalizeUiStateScopeKind(kindRaw);
			if (!scopeKind) {
				return jsonError(`invalid scope kind: ${kindRaw ?? "(missing)"} (session|conversation)`, {
					pretty,
					recovery: ["mu control ui-state get session <scope-id>"],
				});
			}
			const scopeId = normalizeUiStateScopeId(scopeIdRaw);
			if (!scopeId) {
				return jsonError("missing scope id", {
					pretty,
					recovery: ["mu control ui-state get session <scope-id>"],
				});
			}

			const record = store.get({ kind: scopeKind, id: scopeId });
			if (!record) {
				return jsonError(`ui-state scope not found: ${scopeKind}:${scopeId}`, {
					pretty,
					recovery: ["mu control ui-state list"],
				});
			}

			const payload = {
				repo_root: ctx.repoRoot,
				store_path: statePath,
				action: "get",
				record,
			};
			if (jsonMode) {
				return ok(jsonText(payload, pretty));
			}

			let out = `UI docs state scope: ${record.scope.kind}:${record.scope.id}\n`;
			out += `Store: ${statePath}\n`;
			out += `Updated: ${isoForTsMs(record.updated_at_ms)}\n`;
			out += `Revision: ${record.rev}\n`;
			out += `Docs: ${record.docs.length}\n`;
			out += `Writer: ${compactWriterSummary(asRecord(record.writer) ?? {})}\n`;
			if (showDetails) {
				if (record.docs.length === 0) {
					out += "\nDocs: (none)\n";
				} else {
					out += "\nDocs:\n";
					for (const doc of record.docs) {
						out += `  - ${doc.ui_id} rev=${doc.revision.version} title=${doc.title}\n`;
						if (doc.summary && doc.summary.trim().length > 0) {
							out += `      summary: ${doc.summary.trim()}\n`;
						}
					}
				}
			}
			return ok(out);
		}

		return jsonError(`unknown ui-state subcommand: ${sub}`, {
			pretty,
			recovery: ["mu control ui-state --help"],
		});
	}

	async function controlOperator(argv: string[], ctx: Ctx, pretty: boolean): Promise<ControlCommandRunResult> {
		if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
			return ok(
				[
					"mu control operator - inspect/update operator model + thinking",
					"",
					"Usage:",
					"  mu control operator get [--json] [--pretty]",
					"  mu control operator models [provider] [--json] [--pretty]",
					"  mu control operator thinking [provider] [model] [--json] [--pretty]",
					"  mu control operator set <provider> <model> [thinking] [--json] [--pretty]",
					"  mu control operator thinking-set <thinking> [--json] [--pretty]",
					"",
					"Thinking levels: off|minimal|low|medium|high|xhigh",
					"",
					"Examples:",
					"  mu control operator get",
					"  mu control operator models",
					"  mu control operator thinking anthropic claude-opus-4-6",
					"  mu control operator set openai-codex gpt-5.3-codex high",
					"  mu control operator thinking-set minimal",
					"",
					"Notes:",
					"  - set / thinking-set persist workspace config.json",
					"  - if a server is running, mu requests /api/control-plane/reload for live apply",
					"",
					"Run `mu control operator <subcommand> --help` for subcommand details.",
				].join("\n") + "\n",
			);
		}

		const { present: jsonMode, rest: argv0 } = popFlag(argv, "--json");
		if (argv0.length === 0) {
			return jsonError("missing operator subcommand", {
				pretty,
				recovery: ["mu control operator --help"],
			});
		}

		const sub = argv0[0]!;
		const args = argv0.slice(1);

		const { readMuConfigFile, writeMuConfigFile, applyMuConfigPatch, getMuConfigPath } = await import(
			"@femtomc/mu-server"
		);
		const { getModels, getProviders, supportsXhigh } = await import("@mariozechner/pi-ai");
		const { AuthStorage } = await import("@mariozechner/pi-coding-agent");

		const providers = getProviders().map((p) => String(p));
		const authStorage = AuthStorage.create();

		const lookupProvider = (providerRaw: string): string | null => {
			const trimmed = providerRaw.trim();
			if (!isSafeOperatorToken(trimmed)) {
				return null;
			}
			const found = providers.find((p) => p === trimmed);
			return found ?? null;
		};

		const listProviderModels = (provider: string) =>
			getModels(provider as never).map((model) => {
				const xhigh = supportsXhigh(model);
				const reasoning = Boolean(model.reasoning);
				const thinkingLevels = supportedThinkingLevelsForModel({ reasoning, xhigh });
				return {
					id: model.id,
					api: String(model.api),
					reasoning,
					xhigh,
					thinking_levels: thinkingLevels,
					input: [...model.input].map((entry) => String(entry)),
					context_window: model.contextWindow,
					max_tokens: model.maxTokens,
					cost: {
						input: model.cost.input,
						output: model.cost.output,
						cache_read: model.cost.cacheRead,
						cache_write: model.cost.cacheWrite,
					},
				};
			});

		if (sub === "get") {
			if (hasHelpFlag(args)) {
				return ok(
					[
						"mu control operator get - show operator defaults from workspace config",
						"",
						"Usage:",
						"  mu control operator get [--json] [--pretty]",
						"",
						"Examples:",
						"  mu control operator get",
						"  mu control operator get --json --pretty",
					].join("\n") + "\n",
				);
			}
			if (args.length > 0) {
				return jsonError(`unknown args: ${args.join(" ")}`, {
					pretty,
					recovery: ["mu control operator get --help"],
				});
			}
			const config = await readMuConfigFile(ctx.repoRoot);
			const payload = {
				repo_root: ctx.repoRoot,
				config_path: getMuConfigPath(ctx.repoRoot),
				operator: {
					enabled: config.control_plane.operator.enabled,
					provider: config.control_plane.operator.provider,
					model: config.control_plane.operator.model,
					thinking: config.control_plane.operator.thinking,
				},
			};
			if (jsonMode) {
				return ok(jsonText(payload, pretty));
			}
			return ok(
				[
					`Operator config: ${ctx.repoRoot}`,
					`  enabled              ${payload.operator.enabled}`,
					`  provider             ${payload.operator.provider ?? "(default)"}`,
					`  model                ${payload.operator.model ?? "(default)"}`,
					`  thinking             ${payload.operator.thinking ?? "(default)"}`,
				].join("\n") + "\n",
			);
		}

		if (sub === "models") {
			if (hasHelpFlag(args)) {
				return ok(
					[
						"mu control operator models - list provider model catalogs",
						"",
						"Usage:",
						"  mu control operator models [provider] [--json] [--pretty]",
						"",
						"Examples:",
						"  mu control operator models",
						"  mu control operator models anthropic",
						"  mu control operator models openai-codex --json --pretty",
					].join("\n") + "\n",
				);
			}
			if (args.length > 1) {
				return jsonError(`unknown args: ${args.join(" ")}`, {
					pretty,
					recovery: ["mu control operator models --help"],
				});
			}
			const providerFilterRaw = args[0]?.trim();
			let filteredProviders = providers;
			if (providerFilterRaw) {
				const provider = lookupProvider(providerFilterRaw);
				if (!provider) {
					return jsonError(`unknown provider: ${providerFilterRaw}`, {
						pretty,
						recovery: ["mu login --list"],
					});
				}
				filteredProviders = [provider];
			}

			const payload = {
				provider_filter: providerFilterRaw ?? null,
				providers: filteredProviders.map((provider) => ({
					provider,
					authenticated: authStorage.hasAuth(provider),
					model_count: getModels(provider as never).length,
					models: listProviderModels(provider),
				})),
			};
			if (jsonMode) {
				return ok(jsonText(payload, pretty));
			}

			let out = "Operator model catalog\n";
			for (const provider of payload.providers) {
				out += `\n${provider.provider} (${provider.authenticated ? "authenticated" : "not authenticated"})\n`;
				for (const model of provider.models) {
					out += `  - ${model.id} [api=${model.api}, reasoning=${model.reasoning ? "yes" : "no"}, xhigh=${model.xhigh ? "yes" : "no"}, ctx=${model.context_window}, max=${model.max_tokens}, input=${model.input.join(",")}]\n`;
				}
			}
			return ok(out);
		}

		if (sub === "thinking") {
			if (hasHelpFlag(args)) {
				return ok(
					[
						"mu control operator thinking - show allowed thinking levels",
						"",
						"Usage:",
						"  mu control operator thinking [provider] [model] [--json] [--pretty]",
						"",
						"Modes:",
						"  (no args)             Global thinking levels",
						"  <provider>            Thinking levels by model for provider",
						"  <provider> <model>    Thinking levels for one specific model",
						"",
						"Examples:",
						"  mu control operator thinking",
						"  mu control operator thinking anthropic",
						"  mu control operator thinking openai-codex gpt-5.3-codex --json --pretty",
					].join("\n") + "\n",
				);
			}
			if (args.length === 0) {
				const payload = {
					thinking_levels: [...OPERATOR_THINKING_LEVELS],
				};
				return jsonMode
					? ok(jsonText(payload, pretty))
					: ok(`Thinking levels: ${payload.thinking_levels.join(", ")}\n`);
			}
			if (args.length > 2) {
				return jsonError(`unknown args: ${args.join(" ")}`, {
					pretty,
					recovery: ["mu control operator thinking --help"],
				});
			}

			const providerRaw = args[0]!.trim();
			const provider = lookupProvider(providerRaw);
			if (!provider) {
				return jsonError(`unknown provider: ${providerRaw}`, {
					pretty,
					recovery: ["mu login --list"],
				});
			}

			if (args.length === 1) {
				const payload = {
					provider,
					models: listProviderModels(provider).map((model) => ({
						id: model.id,
						thinking_levels: model.thinking_levels,
					})),
				};
				if (jsonMode) {
					return ok(jsonText(payload, pretty));
				}
				let out = `Thinking levels for provider ${provider}\n`;
				for (const model of payload.models) {
					out += `  - ${model.id}: ${model.thinking_levels.join(", ")}\n`;
				}
				return ok(out);
			}

			const modelRaw = args[1]!.trim();
			if (!isSafeOperatorToken(modelRaw)) {
				return jsonError(`invalid model id: ${modelRaw}`, {
					pretty,
					recovery: ["mu control operator models"],
				});
			}
			const model = getModels(provider as never).find((candidate) => candidate.id === modelRaw);
			if (!model) {
				return jsonError(`model not found for provider ${provider}: ${modelRaw}`, {
					pretty,
					recovery: [`mu control operator models ${provider}`],
				});
			}

			const payload = {
				provider,
				model: model.id,
				thinking_levels: supportedThinkingLevelsForModel({
					reasoning: Boolean(model.reasoning),
					xhigh: supportsXhigh(model),
				}),
				reasoning: Boolean(model.reasoning),
				xhigh: supportsXhigh(model),
			};
			if (jsonMode) {
				return ok(jsonText(payload, pretty));
			}
			return ok(`Thinking levels for ${provider}/${model.id}: ${payload.thinking_levels.join(", ")}\n`);
		}

		if (sub === "set") {
			if (hasHelpFlag(args)) {
				return ok(
					[
						"mu control operator set - set provider/model/thinking defaults",
						"",
						"Usage:",
						"  mu control operator set <provider> <model> [thinking] [--json] [--pretty]",
						"",
						"Examples:",
						"  mu control operator set openai-codex gpt-5.3-codex",
						"  mu control operator set anthropic claude-opus-4-6 high",
						"  mu control operator set openai-codex gpt-5.3-codex minimal --json --pretty",
						"",
						"Notes:",
						"  Writes workspace config.json and requests live reload when server is running.",
					].join("\n") + "\n",
				);
			}
			if (args.length < 2 || args.length > 3) {
				return jsonError("usage: mu control operator set <provider> <model> [thinking]", {
					pretty,
					recovery: ["mu control operator --help"],
				});
			}

			const providerRaw = args[0]!.trim();
			const modelRaw = args[1]!.trim();
			const thinkingRaw = args[2]?.trim();
			const provider = lookupProvider(providerRaw);
			if (!provider) {
				return jsonError(`unknown provider: ${providerRaw}`, {
					pretty,
					recovery: ["mu login --list"],
				});
			}
			if (!isSafeOperatorToken(modelRaw)) {
				return jsonError(`invalid model id: ${modelRaw}`, {
					pretty,
					recovery: [`mu control operator models ${provider}`],
				});
			}
			const model = getModels(provider as never).find((candidate) => candidate.id === modelRaw);
			if (!model) {
				return jsonError(`model not found for provider ${provider}: ${modelRaw}`, {
					pretty,
					recovery: [`mu control operator models ${provider}`],
				});
			}

			let thinking: OperatorThinkingLevel | null | undefined = undefined;
			if (thinkingRaw != null) {
				const parsedThinking = normalizeOperatorThinkingLevel(thinkingRaw);
				if (!parsedThinking) {
					return jsonError(`invalid thinking level: ${thinkingRaw}`, {
						pretty,
						recovery: ["mu control operator thinking"],
					});
				}
				const supported = supportedThinkingLevelsForModel({
					reasoning: Boolean(model.reasoning),
					xhigh: supportsXhigh(model),
				});
				if (!supported.includes(parsedThinking)) {
					return jsonError(`thinking level ${parsedThinking} is not supported for ${provider}/${model.id}`, {
						pretty,
						recovery: [`mu control operator thinking ${provider} ${model.id}`],
					});
				}
				thinking = parsedThinking;
			}

			const current = await readMuConfigFile(ctx.repoRoot);
			const next = applyMuConfigPatch(current, {
				control_plane: {
					operator: {
						provider,
						model: model.id,
						...(thinking !== undefined ? { thinking } : {}),
					},
				},
			});
			const configPath = await writeMuConfigFile(ctx.repoRoot, next);
			const reload = await reloadRunningControlPlaneForOperatorUpdate(ctx);

			const payload = {
				ok: true,
				config_path: configPath,
				operator: {
					provider: next.control_plane.operator.provider,
					model: next.control_plane.operator.model,
					thinking: next.control_plane.operator.thinking,
				},
				reload,
			};
			if (jsonMode) {
				return ok(jsonText(payload, pretty));
			}

			let out = `Operator model updated in ${configPath}\n`;
			out += `  provider  ${payload.operator.provider ?? "(default)"}\n`;
			out += `  model     ${payload.operator.model ?? "(default)"}\n`;
			out += `  thinking  ${payload.operator.thinking ?? "(default)"}\n`;
			out += `  reload    ${reload.message}\n`;
			return ok(out);
		}

		if (sub === "thinking-set") {
			if (hasHelpFlag(args)) {
				return ok(
					[
						"mu control operator thinking-set - set default thinking level",
						"",
						"Usage:",
						"  mu control operator thinking-set <thinking> [--json] [--pretty]",
						"",
						"Thinking levels:",
						"  off|minimal|low|medium|high|xhigh",
						"",
						"Examples:",
						"  mu control operator thinking-set minimal",
						"  mu control operator thinking-set high --json --pretty",
					].join("\n") + "\n",
				);
			}
			if (args.length !== 1) {
				return jsonError("usage: mu control operator thinking-set <thinking>", {
					pretty,
					recovery: ["mu control operator --help"],
				});
			}

			const thinking = normalizeOperatorThinkingLevel(args[0]);
			if (!thinking) {
				return jsonError(`invalid thinking level: ${args[0]}`, {
					pretty,
					recovery: ["mu control operator thinking"],
				});
			}

			const current = await readMuConfigFile(ctx.repoRoot);
			const next = applyMuConfigPatch(current, {
				control_plane: {
					operator: {
						thinking,
					},
				},
			});
			const configPath = await writeMuConfigFile(ctx.repoRoot, next);
			const reload = await reloadRunningControlPlaneForOperatorUpdate(ctx);

			const payload = {
				ok: true,
				config_path: configPath,
				operator: {
					provider: next.control_plane.operator.provider,
					model: next.control_plane.operator.model,
					thinking: next.control_plane.operator.thinking,
				},
				reload,
			};
			if (jsonMode) {
				return ok(jsonText(payload, pretty));
			}

			return ok(
				[
					`Operator thinking level updated in ${configPath}`,
					`  thinking  ${payload.operator.thinking ?? "(default)"}`,
					`  reload    ${reload.message}`,
				].join("\n") + "\n",
			);
		}

		return jsonError(`unknown operator subcommand: ${sub}`, {
			pretty,
			recovery: ["mu control operator --help"],
		});
	}

	async function controlReload(argv: string[], ctx: Ctx, pretty: boolean): Promise<ControlCommandRunResult> {
		if (hasHelpFlag(argv)) {
			return ok(
				["mu control reload - trigger running server control-plane reload", "", "Usage:", "  mu control reload [--pretty]"].join("\n") +
					"\n",
			);
		}
		if (argv.length > 0) {
			return jsonError(`unknown args: ${argv.join(" ")}`, { pretty, recovery: ["mu control reload --help"] });
		}
		const reload = await reloadRunningControlPlane({
			ctx,
			reason: "cli_control_reload",
			missingServerMessage: "no running server found; start `mu serve` first",
		});
		if (!reload.ok) {
			return jsonError(`reload failed: ${reload.message}`, {
				pretty,
				recovery: ["mu serve", "mu control status"],
			});
		}
		return ok(jsonText(reload.payload ?? { ok: true, message: reload.message }, pretty));
	}

	async function controlUpdate(argv: string[], ctx: Ctx, pretty: boolean): Promise<ControlCommandRunResult> {
		if (hasHelpFlag(argv)) {
			return ok(
				[
					"mu control update - run update command then schedule process reload",
					"",
					"Usage:",
					"  mu control update [--pretty]",
				].join("\n") + "\n",
			);
		}
		if (argv.length > 0) {
			return jsonError(`unknown args: ${argv.join(" ")}`, { pretty, recovery: ["mu control update --help"] });
		}
		const { createProcessSessionLifecycle } = await import("@femtomc/mu-server");
		const lifecycle = createProcessSessionLifecycle({ repoRoot: ctx.repoRoot });
		const result = await lifecycle.update();
		if (!result.ok) {
			return jsonError(`update failed: ${result.message}`, { pretty, recovery: ["mu control status"] });
		}
		return ok(jsonText(result, pretty));
	}

	return { cmdControl };
}

export async function cmdControl<Ctx extends { repoRoot: string }>(
	argv: string[],
	ctx: Ctx,
	deps: ControlCommandDeps,
): Promise<ControlCommandRunResult> {
	return await buildControlHandlers(deps).cmdControl(argv, ctx);
}
