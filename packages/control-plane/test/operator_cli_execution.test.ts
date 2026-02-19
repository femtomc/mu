import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ApprovedCommandBroker,
	CommandContextResolver,
	type MessagingOperatorBackend,
	MessagingOperatorRuntime,
	type OperatorBackendTurnResult,
} from "@femtomc/mu-agent";
import {
	buildControlPlanePolicy,
	ControlPlaneCommandPipeline,
	ControlPlaneRuntime,
	IdentityStore,
	type InboundEnvelope,
	type MuCliInvocationPlan,
	type MuCliRunResult,
	PolicyEngine,
} from "@femtomc/mu-control-plane";

type FakeCliRunner = {
	plans: MuCliInvocationPlan[];
	runResult: MuCliRunResult;
};

const pipelinesToCleanup = new Set<ControlPlaneCommandPipeline>();

afterEach(async () => {
	for (const pipeline of pipelinesToCleanup) {
		await pipeline.stop();
	}
	pipelinesToCleanup.clear();
});

async function mkTempDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "mu-control-plane-operator-cli-"));
}

function mkInbound(repoRoot: string, overrides: Partial<InboundEnvelope> = {}): InboundEnvelope {
	return {
		v: 1,
		received_at_ms: 10,
		request_id: "req-1",
		delivery_id: "delivery-1",
		channel: "slack",
		channel_tenant_id: "tenant-1",
		channel_conversation_id: "conv-1",
		actor_id: "actor-1",
		actor_binding_id: "binding-1",
		assurance_tier: "tier_a",
		repo_root: repoRoot,
		command_text: "please resume this run",
		scope_required: "cp.read",
		scope_effective: "cp.read",
		target_type: "issue",
		target_id: "mu-root9999",
		idempotency_key: "idem-1",
		fingerprint: "fp-1",
		metadata: {},
		...overrides,
	};
}

class StaticBackend implements MessagingOperatorBackend {
	readonly #result: OperatorBackendTurnResult;

	public constructor(result: OperatorBackendTurnResult) {
		this.#result = result;
	}

	public async runTurn(): Promise<OperatorBackendTurnResult> {
		return this.#result;
	}
}

function createFakeCliRunner(
	runResult: MuCliRunResult,
): FakeCliRunner & { run: (input: { plan: MuCliInvocationPlan; repoRoot: string }) => Promise<MuCliRunResult> } {
	const runner: FakeCliRunner = {
		plans: [],
		runResult,
	};
	return {
		...runner,
		run: async ({ plan }) => {
			runner.plans.push(plan);
			return runResult;
		},
	};
}

async function createPipeline(opts: {
	scopes: string[];
	backendResult: OperatorBackendTurnResult;
	cliRunResult: MuCliRunResult;
}): Promise<{
	repoRoot: string;
	pipeline: ControlPlaneCommandPipeline;
	runtime: ControlPlaneRuntime;
	cli: ReturnType<typeof createFakeCliRunner>;
}> {
	const repoRoot = await mkTempDir();
	let commandSeq = 0;
	let cliSeq = 0;
	const runtime = new ControlPlaneRuntime({
		repoRoot,
		ownerId: "operator-cli-runtime",
		nowMs: () => 10,
	});
	const identities = new IdentityStore(runtime.paths.identitiesPath);
	const policy = new PolicyEngine(buildControlPlanePolicy());
	const broker = new ApprovedCommandBroker({
		contextResolver: new CommandContextResolver({ allowedRepoRoots: [repoRoot] }),
	});
	const operator = new MessagingOperatorRuntime({
		backend: new StaticBackend(opts.backendResult),
		broker,
		sessionIdFactory: () => "operator-session-1",
		turnIdFactory: () => "operator-turn-1",
	});
	const cli = createFakeCliRunner(opts.cliRunResult);

	const pipeline = new ControlPlaneCommandPipeline({
		runtime,
		identityStore: identities,
		policyEngine: policy,
		operator,
		cliRunner: cli,
		commandIdFactory: () => `cmd-operator-${++commandSeq}`,
		cliInvocationIdFactory: () => `cli-operator-${++cliSeq}`,
	});
	await pipeline.start();
	pipelinesToCleanup.add(pipeline);

	await identities.link({
		bindingId: "binding-1",
		operatorId: "operator-1",
		channel: "slack",
		channelTenantId: "tenant-1",
		channelActorId: "actor-1",
		scopes: opts.scopes,
		nowMs: 10,
	});

	return { repoRoot, pipeline, runtime, cli };
}

describe("operator + allowlisted mu CLI execution", () => {
	test("operator-triggered run resumes are confirmed, correlated, and auditable", async () => {
		const harness = await createPipeline({
			scopes: ["cp.read", "cp.run.execute"],
			backendResult: {
				kind: "command",
				command: { kind: "run_resume" },
			},
			cliRunResult: {
				kind: "completed",
				stdout: '{"status":"ok"}',
				stderr: "",
				exitCode: 0,
				runRootId: "mu-root9999",
			},
		});

		const submit = await harness.pipeline.handleInbound(mkInbound(harness.repoRoot));
		expect(submit.kind).toBe("awaiting_confirmation");
		if (submit.kind !== "awaiting_confirmation") {
			throw new Error(`expected awaiting_confirmation, got ${submit.kind}`);
		}

		const confirm = await harness.pipeline.handleInbound(
			mkInbound(harness.repoRoot, {
				request_id: "req-2",
				delivery_id: "delivery-2",
				idempotency_key: "idem-2",
				fingerprint: "fp-2",
				command_text: `mu! confirm ${submit.command.command_id}`,
			}),
		);
		expect(confirm.kind).toBe("completed");
		if (confirm.kind !== "completed") {
			throw new Error(`expected completed, got ${confirm.kind}`);
		}

		expect(confirm.command.cli_invocation_id).toBe("cli-operator-1");
		expect(confirm.command.cli_command_kind).toBe("run_resume");
		expect(confirm.command.run_root_id).toBe("mu-root9999");
		expect(confirm.command.operator_session_id).toBe("operator-session-1");
		expect(confirm.command.operator_turn_id).toBe("operator-turn-1");
		expect(harness.cli.plans.length).toBe(1);
		expect(harness.cli.plans[0]?.argv).toEqual(["mu", "runs", "resume", "mu-root9999", "--max-steps", "20"]);

		const mutating = harness.runtime.journal.mutatingEvents(confirm.command.command_id);
		expect(mutating.some((entry) => entry.event_type === "cli.invocation.started")).toBe(true);
		expect(mutating.some((entry) => entry.event_type === "cli.invocation.completed")).toBe(true);
		for (const entry of mutating) {
			expect(entry.correlation.cli_invocation_id).toBe("cli-operator-1");
			expect(entry.correlation.cli_command_kind).toBe("run_resume");
			expect(entry.correlation.run_root_id).toBe("mu-root9999");
			expect(entry.correlation.operator_session_id).toBe("operator-session-1");
			expect(entry.correlation.operator_turn_id).toBe("operator-turn-1");
		}
	});

	test("operator-triggered run starts are confirmed and preserve prompt args", async () => {
		const harness = await createPipeline({
			scopes: ["cp.read", "cp.run.execute"],
			backendResult: {
				kind: "command",
				command: { kind: "run_start", prompt: "ship release" },
			},
			cliRunResult: {
				kind: "completed",
				stdout: '{"root":"mu-new-root"}',
				stderr: "",
				exitCode: 0,
				runRootId: "mu-new-root",
			},
		});

		const submit = await harness.pipeline.handleInbound(mkInbound(harness.repoRoot));
		expect(submit.kind).toBe("awaiting_confirmation");
		if (submit.kind !== "awaiting_confirmation") {
			throw new Error(`expected awaiting_confirmation, got ${submit.kind}`);
		}
		expect(submit.command.command_args).toEqual(["ship", "release"]);

		const confirm = await harness.pipeline.handleInbound(
			mkInbound(harness.repoRoot, {
				request_id: "req-2",
				delivery_id: "delivery-2",
				idempotency_key: "idem-2",
				fingerprint: "fp-2",
				command_text: `mu! confirm ${submit.command.command_id}`,
			}),
		);
		expect(confirm.kind).toBe("completed");
		if (confirm.kind !== "completed") {
			throw new Error(`expected completed, got ${confirm.kind}`);
		}
		expect(confirm.command.cli_command_kind).toBe("run_start");
		expect(confirm.command.run_root_id).toBe("mu-new-root");
		expect(harness.cli.plans.length).toBe(1);
		expect(harness.cli.plans[0]?.argv).toEqual(["mu", "runs", "start", "ship release", "--max-steps", "20"]);
	});

	test("operator readonly status queries execute through allowlisted mu CLI", async () => {
		const harness = await createPipeline({
			scopes: ["cp.read"],
			backendResult: {
				kind: "command",
				command: { kind: "status" },
			},
			cliRunResult: {
				kind: "completed",
				stdout: '{"open_count":2}',
				stderr: "",
				exitCode: 0,
				runRootId: null,
			},
		});

		const result = await harness.pipeline.handleInbound(mkInbound(harness.repoRoot));
		expect(result.kind).toBe("completed");
		if (result.kind !== "completed") {
			throw new Error(`expected completed, got ${result.kind}`);
		}

		expect(result.command.cli_command_kind).toBe("status");
		expect(result.command.operator_session_id).toBe("operator-session-1");
		expect(result.command.operator_turn_id).toBe("operator-turn-1");
		expect(harness.cli.plans.length).toBe(1);
		expect(harness.cli.plans[0]?.argv).toEqual(["mu", "status", "--json"]);

		const payload = result.command.result as Record<string, unknown>;
		expect(payload.stdout).toBe('{"open_count":2}');
		expect(payload.cli_command_kind).toBe("status");
	});

	test("operator can inspect orchestration runs via run list + run status", async () => {
		const listHarness = await createPipeline({
			scopes: ["cp.read"],
			backendResult: {
				kind: "command",
				command: { kind: "run_list" },
			},
			cliRunResult: {
				kind: "completed",
				stdout: "[]",
				stderr: "",
				exitCode: 0,
				runRootId: null,
			},
		});
		const listResult = await listHarness.pipeline.handleInbound(mkInbound(listHarness.repoRoot));
		expect(listResult.kind).toBe("completed");
		if (listResult.kind !== "completed") {
			throw new Error(`expected completed, got ${listResult.kind}`);
		}
		expect(listResult.command.cli_command_kind).toBe("run_list");
		expect(listHarness.cli.plans[0]?.argv).toEqual(["mu", "runs", "list", "--limit", "100"]);

		const statusHarness = await createPipeline({
			scopes: ["cp.read"],
			backendResult: {
				kind: "command",
				command: { kind: "run_status", root_issue_id: "mu-root9999" },
			},
			cliRunResult: {
				kind: "completed",
				stdout: '{"id":"mu-root9999"}',
				stderr: "",
				exitCode: 0,
				runRootId: "mu-root9999",
			},
		});
		const statusResult = await statusHarness.pipeline.handleInbound(mkInbound(statusHarness.repoRoot));
		expect(statusResult.kind).toBe("completed");
		if (statusResult.kind !== "completed") {
			throw new Error(`expected completed, got ${statusResult.kind}`);
		}
		expect(statusResult.command.cli_command_kind).toBe("run_status");
		expect(statusHarness.cli.plans[0]?.argv).toEqual(["mu", "runs", "get", "mu-root9999"]);
	});

	test("operator readonly CLI failures surface deterministic error reasons", async () => {
		const harness = await createPipeline({
			scopes: ["cp.read"],
			backendResult: {
				kind: "command",
				command: { kind: "status" },
			},
			cliRunResult: {
				kind: "failed",
				errorCode: "cli_nonzero",
				stdout: "",
				stderr: "boom",
				exitCode: 1,
				runRootId: null,
			},
		});

		const failed = await harness.pipeline.handleInbound(mkInbound(harness.repoRoot));
		expect(failed.kind).toBe("failed");
		if (failed.kind !== "failed") {
			throw new Error(`expected failed, got ${failed.kind}`);
		}
		expect(failed.reason).toBe("cli_nonzero");
		expect(failed.command.cli_command_kind).toBe("status");
		expect(harness.cli.plans.length).toBe(1);
		expect(harness.cli.plans[0]?.argv).toEqual(["mu", "status", "--json"]);
	});

	test("unauthorized run triggers are denied before confirmation", async () => {
		const harness = await createPipeline({
			scopes: ["cp.read"],
			backendResult: {
				kind: "command",
				command: { kind: "run_resume", root_issue_id: "mu-root9999" },
			},
			cliRunResult: {
				kind: "completed",
				stdout: "{}",
				stderr: "",
				exitCode: 0,
				runRootId: "mu-root9999",
			},
		});

		const denied = await harness.pipeline.handleInbound(mkInbound(harness.repoRoot));
		expect(denied).toEqual({ kind: "denied", reason: "missing_scope" });
		expect(harness.cli.plans.length).toBe(0);
	});

	test("CLI failures surface deterministic failure reasons", async () => {
		const harness = await createPipeline({
			scopes: ["cp.read", "cp.run.execute"],
			backendResult: {
				kind: "command",
				command: { kind: "run_resume", root_issue_id: "mu-root9999" },
			},
			cliRunResult: {
				kind: "failed",
				errorCode: "cli_timeout",
				stdout: "",
				stderr: "timed out",
				exitCode: null,
				runRootId: "mu-root9999",
			},
		});

		const submit = await harness.pipeline.handleInbound(mkInbound(harness.repoRoot));
		expect(submit.kind).toBe("awaiting_confirmation");
		if (submit.kind !== "awaiting_confirmation") {
			throw new Error(`expected awaiting_confirmation, got ${submit.kind}`);
		}

		const failed = await harness.pipeline.handleInbound(
			mkInbound(harness.repoRoot, {
				request_id: "req-2",
				delivery_id: "delivery-2",
				idempotency_key: "idem-2",
				fingerprint: "fp-2",
				command_text: `mu! confirm ${submit.command.command_id}`,
			}),
		);
		expect(failed.kind).toBe("failed");
		if (failed.kind !== "failed") {
			throw new Error(`expected failed, got ${failed.kind}`);
		}
		expect(failed.reason).toBe("cli_timeout");
		expect(failed.command.error_code).toBe("cli_timeout");
		expect(failed.command.cli_invocation_id).toBe("cli-operator-1");

		const mutating = harness.runtime.journal.mutatingEvents(failed.command.command_id);
		expect(mutating.some((entry) => entry.event_type === "cli.invocation.failed")).toBe(true);
	});
});
