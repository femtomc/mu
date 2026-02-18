import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type CmdResult = { code: number; stdout: string; stderr: string };

type TokenRule = {
	token: string;
	reason: string;
};

type RegexRule = {
	pattern: RegExp;
	label: string;
	reason: string;
};

type SourceBoundaryRule = {
	file: string;
	description: string;
	forbiddenTokens?: TokenRule[];
	requiredTokens?: TokenRule[];
	forbiddenPatterns?: RegexRule[];
};

type TokenMatch = {
	line: number;
	snippet: string;
};

type BoundaryViolation = {
	file: string;
	description: string;
	message: string;
};

const AUDIT_TOPIC = "research:mu:clean-architecture-audit:2026-02-18";

const PHASE_CRITICAL_TESTS = [
	"packages/control-plane/test/modular_boundaries.test.ts",
	"packages/control-plane/test/adapter_contract.test.ts",
	"packages/control-plane/test/interaction_contract.test.ts",
	"packages/server/test/modular_boundaries.test.ts",
	"packages/server/test/reload_observability.test.ts",
	"packages/core/test/jsonl.test.ts",
	"packages/forum/test/forum.test.ts",
	"packages/issue/test/issue.test.ts",
	"packages/server/test/server.test.ts",
] as const;

const SOURCE_BOUNDARY_RULES: SourceBoundaryRule[] = [
	{
		file: "packages/control-plane/src/channel_adapters.ts",
		description: "channel adapters remain thin translators over command pipeline/runtime boundaries",
		forbiddenTokens: [
			{ token: "@femtomc/mu-issue", reason: "do not couple adapters directly to issue persistence" },
			{ token: "@femtomc/mu-forum", reason: "do not couple adapters directly to forum persistence" },
			{ token: "@femtomc/mu-orchestrator", reason: "do not couple adapters to orchestration engine" },
			{ token: "packages/issue", reason: "do not bypass package boundaries with source imports" },
			{ token: "packages/forum", reason: "do not bypass package boundaries with source imports" },
			{ token: ".journal.append", reason: "adapter layer must not mutate command journal directly" },
			{
				token: ".executeSerializedMutation(",
				reason: "adapter layer must not invoke mutation executor directly",
			},
		],
		requiredTokens: [
			{
				token: "ControlPlaneCommandPipeline",
				reason: "adapter path should route work through the command pipeline seam",
			},
		],
	},
	{
		file: "packages/control-plane/src/command_pipeline.ts",
		description: "command pipeline is isolated from mu-agent runtime package",
		forbiddenTokens: [
			{
				token: "@femtomc/mu-agent",
				reason: "command pipeline must depend on local contracts instead of runtime package imports",
			},
		],
		requiredTokens: [
			{
				token: "MessagingOperatorRuntimeLike",
				reason: "pipeline should depend on operator runtime interface contract",
			},
			{
				token: "DefaultCommandContextResolver",
				reason: "pipeline should use internal command-context seam",
			},
		],
	},
	{
		file: "packages/server/src/server.ts",
		description: "server composes control-plane through explicit seam contracts",
		requiredTokens: [
			{
				token: 'import { bootstrapControlPlane } from "./control_plane.js";',
				reason: "server should bootstrap control plane through implementation module",
			},
			{
				token: 'from "./control_plane_contract.js"',
				reason: "server should consume seam types from control_plane_contract",
			},
		],
		forbiddenPatterns: [
			{
				pattern: /import\s*{[^}]*type\s+ControlPlaneHandle[^}]*}\s*from\s*"\.\/control_plane\.js"/m,
				label: 'type ControlPlaneHandle import from "./control_plane.js"',
				reason: "server should import ControlPlaneHandle from contract module, not implementation module",
			},
		],
	},
	{
		file: "packages/server/src/control_plane_contract.ts",
		description: "control-plane seam contract stays implementation-agnostic",
		forbiddenTokens: [
			{
				token: "./control_plane.js",
				reason: "contract module must not import implementation module",
			},
			{
				token: "bootstrapControlPlane",
				reason: "contract module must not reference composition-root bootstrap function",
			},
		],
	},
];

function repoRootFromHere(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function findTokenMatches(source: string, token: string): TokenMatch[] {
	const lines = source.split(/\r?\n/);
	const matches: TokenMatch[] = [];
	for (let idx = 0; idx < lines.length; idx += 1) {
		const line = lines[idx] ?? "";
		if (line.includes(token)) {
			matches.push({ line: idx + 1, snippet: line.trimEnd() });
		}
	}
	return matches;
}

function summarizeMatches(matches: TokenMatch[]): string {
	if (matches.length === 0) {
		return "(no matches)";
	}
	const shown = matches.slice(0, 3);
	const lines = shown.map((match) => `line ${match.line}: ${match.snippet}`);
	if (matches.length > shown.length) {
		lines.push(`... ${matches.length - shown.length} more match(es)`);
	}
	return lines.join("\n");
}

function collectTokenViolations(opts: {
	source: string;
	rule: SourceBoundaryRule;
	tokenRule: TokenRule;
	mode: "forbidden" | "required";
}): BoundaryViolation[] {
	const matches = findTokenMatches(opts.source, opts.tokenRule.token);
	if (opts.mode === "forbidden") {
		if (matches.length === 0) {
			return [];
		}
		return [
			{
				file: opts.rule.file,
				description: opts.rule.description,
				message: [
					`forbidden token \"${opts.tokenRule.token}\" detected`,
					`why: ${opts.tokenRule.reason}`,
					summarizeMatches(matches),
				].join("\n"),
			},
		];
	}
	if (matches.length > 0) {
		return [];
	}
	return [
		{
			file: opts.rule.file,
			description: opts.rule.description,
			message: [
				`missing required token \"${opts.tokenRule.token}\"`,
				`why: ${opts.tokenRule.reason}`,
			].join("\n"),
		},
	];
}

function collectRegexViolations(opts: {
	source: string;
	rule: SourceBoundaryRule;
	regexRule: RegexRule;
}): BoundaryViolation[] {
	if (!opts.regexRule.pattern.test(opts.source)) {
		return [];
	}
	return [
		{
			file: opts.rule.file,
			description: opts.rule.description,
			message: [
				`forbidden pattern detected: ${opts.regexRule.label}`,
				`why: ${opts.regexRule.reason}`,
				`pattern: ${opts.regexRule.pattern.toString()}`,
			].join("\n"),
		},
	];
}

async function runCmd(cmd: string, args: string[], opts: { cwd: string }): Promise<CmdResult> {
	const proc = Bun.spawn({
		cmd: [cmd, ...args],
		cwd: opts.cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { code, stdout, stderr };
}

async function runBoundaryChecks(repoRoot: string): Promise<void> {
	const dryRun = Bun.env.MU_GUARDRAILS_DRY_RUN_FAIL === "1";
	if (dryRun) {
		console.warn("[guardrails] intentional fail dry-run enabled (MU_GUARDRAILS_DRY_RUN_FAIL=1)");
	}

	const sourceByFile = new Map<string, string>();
	for (const rule of SOURCE_BOUNDARY_RULES) {
		const absPath = resolve(repoRoot, rule.file);
		sourceByFile.set(rule.file, await readFile(absPath, "utf8"));
	}

	if (dryRun) {
		const file = "packages/control-plane/src/command_pipeline.ts";
		const base = sourceByFile.get(file) ?? "";
		sourceByFile.set(
			file,
			`${base}\nimport type { ApprovedCommandBroker } from "@femtomc/mu-agent"; // dry-run boundary regression`,
		);
	}

	const violations: BoundaryViolation[] = [];
	for (const rule of SOURCE_BOUNDARY_RULES) {
		const source = sourceByFile.get(rule.file) ?? "";
		for (const tokenRule of rule.forbiddenTokens ?? []) {
			violations.push(...collectTokenViolations({ source, rule, tokenRule, mode: "forbidden" }));
		}
		for (const tokenRule of rule.requiredTokens ?? []) {
			violations.push(...collectTokenViolations({ source, rule, tokenRule, mode: "required" }));
		}
		for (const regexRule of rule.forbiddenPatterns ?? []) {
			violations.push(...collectRegexViolations({ source, rule, regexRule }));
		}
	}

	const controlPlanePkgRaw = await readFile(resolve(repoRoot, "packages/control-plane/package.json"), "utf8");
	const controlPlanePkg = JSON.parse(controlPlanePkgRaw) as {
		dependencies?: Record<string, string>;
	};
	if (controlPlanePkg.dependencies?.["@femtomc/mu-agent"] !== undefined) {
		violations.push({
			file: "packages/control-plane/package.json",
			description: "control-plane package dependency boundaries",
			message: [
				"forbidden dependency detected: @femtomc/mu-agent",
				"why: control-plane should remain runtime-package agnostic and consume local contracts",
			].join("\n"),
		});
	}

	if (violations.length > 0) {
		console.error("[guardrails] boundary violations detected:\n");
		for (const violation of violations) {
			console.error(`- ${violation.file}`);
			console.error(`  seam: ${violation.description}`);
			console.error(
				violation.message
					.split("\n")
					.map((line) => `  ${line}`)
					.join("\n"),
			);
			console.error("");
		}
		throw new Error(`[guardrails] ${violations.length} boundary violation(s) found`);
	}

	console.log(`[guardrails] boundary checks passed (${SOURCE_BOUNDARY_RULES.length + 1} seams)`);
}

async function runPhaseCriticalTests(repoRoot: string): Promise<void> {
	console.log(`[guardrails] running phase-critical regression suite (${PHASE_CRITICAL_TESTS.length} files)`);
	const result = await runCmd("bun", ["test", ...PHASE_CRITICAL_TESTS], { cwd: repoRoot });
	if (result.stdout.trim().length > 0) {
		process.stdout.write(result.stdout);
	}
	if (result.stderr.trim().length > 0) {
		process.stderr.write(result.stderr);
	}
	if (result.code !== 0) {
		throw new Error(`[guardrails] phase-critical test suite failed (exit=${result.code})`);
	}
}

function printUsage(): void {
	console.log("Usage: bun run scripts/guardrails.ts [--boundaries-only]");
}

async function main(): Promise<void> {
	if (Bun.argv.includes("--help") || Bun.argv.includes("-h")) {
		printUsage();
		return;
	}

	const boundariesOnly = Bun.argv.includes("--boundaries-only");
	const repoRoot = repoRootFromHere();
	console.log(`[guardrails] audit baseline: ${AUDIT_TOPIC}`);

	await runBoundaryChecks(repoRoot);
	if (boundariesOnly) {
		console.log("[guardrails] boundaries-only mode complete");
		return;
	}
	await runPhaseCriticalTests(repoRoot);
	console.log("[guardrails] complete");
}

await main();
