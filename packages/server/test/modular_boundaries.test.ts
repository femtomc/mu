import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const serverPath = join(import.meta.dir, "..", "src", "server.ts");
const controlPlanePath = join(import.meta.dir, "..", "src", "control_plane.ts");
const contractPath = join(import.meta.dir, "..", "src", "control_plane_contract.ts");

describe("server/control-plane modular boundaries", () => {
	test("server composes control-plane through explicit contract seam", async () => {
		const source = await readFile(serverPath, "utf8");

		expect(source).toContain('import { bootstrapControlPlane } from "./control_plane.js";');
		expect(source).toContain('from "./control_plane_contract.js"');

		const directTypeImport =
			/import\s*{[^}]*type\s+ControlPlaneHandle[^}]*}\s*from\s*"\.\/control_plane\.js"/m;
		expect(directTypeImport.test(source)).toBe(false);
	});

	test("control-plane implementation re-exports contract seam types", async () => {
		const source = await readFile(controlPlanePath, "utf8");

		expect(source).toContain('from "./control_plane_contract.js"');
		expect(source).toContain("export type {");
	});

	test("contract seam stays implementation-agnostic", async () => {
		const source = await readFile(contractPath, "utf8");

		expect(source).not.toContain("./control_plane.js");
		expect(source).not.toContain("bootstrapControlPlane");
	});
});
