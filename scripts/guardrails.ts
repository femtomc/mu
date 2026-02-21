import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
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
	/** Single file path or array of file paths (sources are concatenated for multi-file rules). */
	file: string | string[];
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

type WorkspaceManifest = {
	name: string;
	packageJsonPath: string;
	internalDependencies: string[];
};

type DependencyEdgeOverride = {
	from: string;
	to: string;
	reason: string;
	issue: string;
	expiresOn: string;
};

type GuardrailAllowlistFile = {
	dependencyEdgeOverrides?: DependencyEdgeOverride[];
};

const AUDIT_TOPIC = "research:mu:clean-architecture-audit:2026-02-18";
const ALLOWLIST_PATH = "scripts/guardrails-allowlist.json";

const INTERNAL_PACKAGE_DEPENDENCY_INVARIANTS: Record<string, readonly string[]> = {
	"@femtomc/mu-core": [],
	"@femtomc/mu-agent": ["@femtomc/mu-core"],
	"@femtomc/mu-control-plane": ["@femtomc/mu-core"],
	"@femtomc/mu-forum": ["@femtomc/mu-core"],
	"@femtomc/mu-issue": ["@femtomc/mu-core"],
	"@femtomc/mu-server": ["@femtomc/mu-agent", "@femtomc/mu-control-plane", "@femtomc/mu-core"],
	"@femtomc/mu": [
		"@femtomc/mu-agent",
		"@femtomc/mu-control-plane",
		"@femtomc/mu-core",
		"@femtomc/mu-forum",
		"@femtomc/mu-issue",
		"@femtomc/mu-server",
	],
};

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
		file: [
			"packages/control-plane/src/adapters/shared.ts",
			"packages/control-plane/src/adapters/slack.ts",
			"packages/control-plane/src/adapters/discord.ts",
			"packages/control-plane/src/adapters/telegram.ts",
		],
		description: "channel adapters remain thin translators over command pipeline/runtime boundaries",
		forbiddenTokens: [
			{ token: "@femtomc/mu-issue", reason: "do not couple adapters directly to issue persistence" },
			{ token: "@femtomc/mu-forum", reason: "do not couple adapters directly to forum persistence" },
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

function isoDateUtcToday(): string {
	return new Date().toISOString().slice(0, 10);
}

function isIsoDate(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}$/.test(value);
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
				file: ruleLabel(opts.rule),
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
			file: ruleLabel(opts.rule),
			description: opts.rule.description,
			message: [`missing required token \"${opts.tokenRule.token}\"`, `why: ${opts.tokenRule.reason}`].join("\n"),
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
			file: ruleLabel(opts.rule),
			description: opts.rule.description,
			message: [
				`forbidden pattern detected: ${opts.regexRule.label}`,
				`why: ${opts.regexRule.reason}`,
				`pattern: ${opts.regexRule.pattern.toString()}`,
			].join("\n"),
		},
	];
}

function ruleKey(rule: SourceBoundaryRule): string {
	return Array.isArray(rule.file) ? rule.file.join(", ") : rule.file;
}

function ruleLabel(rule: SourceBoundaryRule): string {
	return Array.isArray(rule.file) ? rule.file[0].replace(/\/[^/]+$/, "/*") : rule.file;
}

function collectSourceBoundaryViolations(sourceByRule: Map<string, string>): BoundaryViolation[] {
	const violations: BoundaryViolation[] = [];
	for (const rule of SOURCE_BOUNDARY_RULES) {
		const source = sourceByRule.get(ruleKey(rule)) ?? "";
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
	return violations;
}

async function loadWorkspaceManifests(repoRoot: string): Promise<Map<string, WorkspaceManifest>> {
	const manifestsRaw: Array<{
		name: string;
		packageJsonPath: string;
		rawDependencies: string[];
	}> = [];

	const packagesRoot = resolve(repoRoot, "packages");
	const entries = await readdir(packagesRoot, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		const packageJsonPathAbs = resolve(packagesRoot, entry.name, "package.json");
		let packageJsonRaw: string;
		try {
			packageJsonRaw = await readFile(packageJsonPathAbs, "utf8");
		} catch {
			continue;
		}

		const parsed = JSON.parse(packageJsonRaw) as {
			name?: string;
			dependencies?: Record<string, string>;
		};
		if (!parsed.name) {
			continue;
		}

		manifestsRaw.push({
			name: parsed.name,
			packageJsonPath: relative(repoRoot, packageJsonPathAbs),
			rawDependencies: Object.keys(parsed.dependencies ?? {}),
		});
	}

	const workspaceNames = new Set(manifestsRaw.map((manifest) => manifest.name));
	const manifests = new Map<string, WorkspaceManifest>();
	for (const manifest of manifestsRaw) {
		const internalDependencies = manifest.rawDependencies
			.filter((depName) => workspaceNames.has(depName))
			.toSorted((a, b) => a.localeCompare(b));
		manifests.set(manifest.name, {
			name: manifest.name,
			packageJsonPath: manifest.packageJsonPath,
			internalDependencies,
		});
	}
	return manifests;
}

function parseDependencyOverride(value: unknown, index: number): DependencyEdgeOverride {
	if (typeof value !== "object" || value === null) {
		throw new Error(`override entry #${index + 1} must be an object`);
	}
	const candidate = value as Record<string, unknown>;
	const from = candidate.from;
	const to = candidate.to;
	const reason = candidate.reason;
	const issue = candidate.issue;
	const expiresOn = candidate.expiresOn;

	if (typeof from !== "string" || from.trim().length === 0) {
		throw new Error(`override entry #${index + 1} has invalid \"from\" package name`);
	}
	if (typeof to !== "string" || to.trim().length === 0) {
		throw new Error(`override entry #${index + 1} has invalid \"to\" package name`);
	}
	if (typeof reason !== "string" || reason.trim().length === 0) {
		throw new Error(`override entry #${index + 1} must include a non-empty \"reason\"`);
	}
	if (typeof issue !== "string" || issue.trim().length === 0) {
		throw new Error(`override entry #${index + 1} must include a non-empty \"issue\" link/id`);
	}
	if (typeof expiresOn !== "string" || !isIsoDate(expiresOn)) {
		throw new Error(`override entry #${index + 1} must include \"expiresOn\" in YYYY-MM-DD format`);
	}

	return {
		from: from.trim(),
		to: to.trim(),
		reason: reason.trim(),
		issue: issue.trim(),
		expiresOn,
	};
}

async function loadDependencyOverrides(repoRoot: string): Promise<DependencyEdgeOverride[]> {
	const allowlistPathAbs = resolve(repoRoot, ALLOWLIST_PATH);
	const raw = await readFile(allowlistPathAbs, "utf8");
	const parsed = JSON.parse(raw) as GuardrailAllowlistFile;

	if (parsed === null || typeof parsed !== "object") {
		throw new Error("allowlist root must be an object");
	}

	const rawOverrides = parsed.dependencyEdgeOverrides ?? [];
	if (!Array.isArray(rawOverrides)) {
		throw new Error("dependencyEdgeOverrides must be an array");
	}

	return rawOverrides.map((override, index) => parseDependencyOverride(override, index));
}

function collectDependencyDirectionViolations(opts: {
	manifests: Map<string, WorkspaceManifest>;
	overrides: DependencyEdgeOverride[];
}): BoundaryViolation[] {
	const violations: BoundaryViolation[] = [];
	const packageNames = [...opts.manifests.keys()].toSorted((a, b) => a.localeCompare(b));
	const packageNameSet = new Set(packageNames);

	for (const packageName of packageNames) {
		if (INTERNAL_PACKAGE_DEPENDENCY_INVARIANTS[packageName] === undefined) {
			violations.push({
				file: "scripts/guardrails.ts",
				description: "dependency-direction invariant baseline completeness",
				message: [
					`missing internal dependency invariant entry for package: ${packageName}`,
					"why: architecture guardrail requires explicit baseline coverage for every workspace package",
				].join("\n"),
			});
		}
	}

	for (const [packageName, allowedDeps] of Object.entries(INTERNAL_PACKAGE_DEPENDENCY_INVARIANTS)) {
		if (!packageNameSet.has(packageName)) {
			violations.push({
				file: "scripts/guardrails.ts",
				description: "dependency-direction invariant baseline coherence",
				message: [
					`stale internal dependency invariant entry for unknown package: ${packageName}`,
					"why: baseline should only reference live workspace packages",
				].join("\n"),
			});
		}
		for (const depName of allowedDeps) {
			if (!packageNameSet.has(depName)) {
				violations.push({
					file: "scripts/guardrails.ts",
					description: "dependency-direction invariant baseline coherence",
					message: [
						`invariant for ${packageName} references unknown dependency ${depName}`,
						"why: allowed dependency lists must only reference workspace packages",
					].join("\n"),
				});
			}
		}
	}

	const today = isoDateUtcToday();
	const activeOverridesByFrom = new Map<string, DependencyEdgeOverride[]>();
	for (const override of opts.overrides) {
		if (!packageNameSet.has(override.from)) {
			violations.push({
				file: ALLOWLIST_PATH,
				description: "dependency override allowlist validity",
				message: [
					`override source package is unknown: ${override.from}`,
					"why: override paths must reference workspace package names",
				].join("\n"),
			});
			continue;
		}
		if (!packageNameSet.has(override.to)) {
			violations.push({
				file: ALLOWLIST_PATH,
				description: "dependency override allowlist validity",
				message: [
					`override target package is unknown: ${override.to}`,
					"why: override paths must reference workspace package names",
				].join("\n"),
			});
			continue;
		}
		if (override.expiresOn < today) {
			violations.push({
				file: ALLOWLIST_PATH,
				description: "dependency override allowlist expiry",
				message: [
					`override expired: ${override.from} -> ${override.to} (expiresOn=${override.expiresOn})`,
					`reason: ${override.reason}`,
					`issue: ${override.issue}`,
					"why: temporary architecture overrides must be removed or renewed before they expire",
				].join("\n"),
			});
			continue;
		}
		const group = activeOverridesByFrom.get(override.from) ?? [];
		group.push(override);
		activeOverridesByFrom.set(override.from, group);
	}

	for (const packageName of packageNames) {
		const manifest = opts.manifests.get(packageName);
		if (!manifest) {
			continue;
		}
		const baselineAllowedDeps = INTERNAL_PACKAGE_DEPENDENCY_INVARIANTS[packageName] ?? [];
		const allowedDeps = new Set<string>(baselineAllowedDeps);
		for (const override of activeOverridesByFrom.get(packageName) ?? []) {
			allowedDeps.add(override.to);
		}
		const allowedDepsSummary = [...allowedDeps].toSorted((a, b) => a.localeCompare(b)).join(", ") || "(none)";

		for (const actualDep of manifest.internalDependencies) {
			if (allowedDeps.has(actualDep)) {
				continue;
			}
			violations.push({
				file: manifest.packageJsonPath,
				description: "package dependency direction invariants (audit baseline)",
				message: [
					`forbidden internal dependency detected: ${packageName} -> ${actualDep}`,
					`allowed internal dependencies: ${allowedDepsSummary}`,
					`temporary override path: ${ALLOWLIST_PATH}`,
				].join("\n"),
			});
		}
	}

	return violations;
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

async function runArchitectureChecks(repoRoot: string): Promise<void> {
	const dryRunSourceFail = Bun.env.MU_GUARDRAILS_DRY_RUN_FAIL === "1";
	const dryRunDependencyFail = Bun.env.MU_GUARDRAILS_DRY_RUN_DEPENDENCY_FAIL === "1";
	if (dryRunSourceFail) {
		console.warn("[guardrails] intentional source fail dry-run enabled (MU_GUARDRAILS_DRY_RUN_FAIL=1)");
	}
	if (dryRunDependencyFail) {
		console.warn(
			"[guardrails] intentional dependency fail dry-run enabled (MU_GUARDRAILS_DRY_RUN_DEPENDENCY_FAIL=1)",
		);
	}

	const sourceByRule = new Map<string, string>();
	for (const rule of SOURCE_BOUNDARY_RULES) {
		const files = Array.isArray(rule.file) ? rule.file : [rule.file];
		const parts: string[] = [];
		for (const f of files) {
			parts.push(await readFile(resolve(repoRoot, f), "utf8"));
		}
		const key = Array.isArray(rule.file) ? rule.file.join(", ") : rule.file;
		sourceByRule.set(key, parts.join("\n"));
	}

	if (dryRunSourceFail) {
		const file = "packages/control-plane/src/command_pipeline.ts";
		const base = sourceByRule.get(file) ?? "";
		sourceByRule.set(
			file,
			`${base}\nimport type { ApprovedCommandBroker } from "@femtomc/mu-agent"; // dry-run boundary regression`,
		);
	}

	const violations: BoundaryViolation[] = [];
	violations.push(...collectSourceBoundaryViolations(sourceByRule));

	const manifests = await loadWorkspaceManifests(repoRoot);
	if (dryRunDependencyFail) {
		const forumManifest = manifests.get("@femtomc/mu-forum");
		if (forumManifest) {
			const depSet = new Set(forumManifest.internalDependencies);
			depSet.add("@femtomc/mu-server");
			forumManifest.internalDependencies = [...depSet].toSorted((a, b) => a.localeCompare(b));
		}
	}

	let overrides: DependencyEdgeOverride[] = [];
	try {
		overrides = await loadDependencyOverrides(repoRoot);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		violations.push({
			file: ALLOWLIST_PATH,
			description: "dependency override allowlist parse",
			message: `failed to parse allowlist file: ${message}`,
		});
	}

	violations.push(...collectDependencyDirectionViolations({ manifests, overrides }));

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

	console.log(
		`[guardrails] architecture checks passed (${SOURCE_BOUNDARY_RULES.length} source seams + ${manifests.size} package dependency invariants)`,
	);
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
	console.log("Usage: bun run scripts/guardrails.ts [--architecture-only]");
}

async function main(): Promise<void> {
	if (Bun.argv.includes("--help") || Bun.argv.includes("-h")) {
		printUsage();
		return;
	}

	const architectureOnly = Bun.argv.includes("--architecture-only") || Bun.argv.includes("--boundaries-only");
	const repoRoot = repoRootFromHere();
	console.log(`[guardrails] audit baseline: ${AUDIT_TOPIC}`);

	await runArchitectureChecks(repoRoot);
	if (architectureOnly) {
		console.log("[guardrails] architecture-only mode complete");
		return;
	}
	await runPhaseCriticalTests(repoRoot);
	console.log("[guardrails] complete");
}

await main();
