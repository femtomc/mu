import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const channelAdapterPath = join(import.meta.dir, "..", "src", "channel_adapters.ts");
const commandPipelinePath = join(import.meta.dir, "..", "src", "command_pipeline.ts");
const controlPlanePackageJsonPath = join(import.meta.dir, "..", "package.json");

describe("control-plane modular boundaries", () => {
	test("channel adapters remain thin translators and do not bypass control-plane mutation interfaces", async () => {
		const source = await readFile(channelAdapterPath, "utf8");

		const forbiddenSpecifiers = [
			"@femtomc/mu-issue",
			"@femtomc/mu-forum",
			"@femtomc/mu-orchestrator",
			"packages/issue",
			"packages/forum",
		];
		for (const specifier of forbiddenSpecifiers) {
			expect(source).not.toContain(specifier);
		}

		expect(source).not.toContain(".journal.append");
		expect(source).not.toContain(".executeSerializedMutation(");
		expect(source).toContain("ControlPlaneCommandPipeline");
	});

	test("inventory: command pipeline currently couples to mu-agent (P0 seam to remove)", async () => {
		const [source, packageJsonRaw] = await Promise.all([
			readFile(commandPipelinePath, "utf8"),
			readFile(controlPlanePackageJsonPath, "utf8"),
		]);
		const packageJson = JSON.parse(packageJsonRaw) as {
			dependencies?: Record<string, string>;
		};

		expect(source).toContain("@femtomc/mu-agent");
		expect(packageJson.dependencies?.["@femtomc/mu-agent"]).toBeDefined();
	});
});
