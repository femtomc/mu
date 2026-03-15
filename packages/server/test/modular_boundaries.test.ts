import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const serverPath = join(import.meta.dir, "..", "src", "server.ts");
const controlPlanePath = join(import.meta.dir, "..", "src", "control_plane.ts");
const contractPath = join(import.meta.dir, "..", "src", "control_plane_contract.ts");
const daemonThinHostPath = join(import.meta.dir, "..", "src", "daemon_thin_host.ts");
const serverRuntimePath = join(import.meta.dir, "..", "src", "server_runtime.ts");

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

	test("daemon thin-host boundary module does not import server domain modules", async () => {
		const source = await readFile(daemonThinHostPath, "utf8");

		// thin-host should only depend on daemon_session_adapter and control_plane_contract
		expect(source).not.toContain("./server.js");
		expect(source).not.toContain("./control_plane.js");
		expect(source).not.toContain("./server_routing.js");

		// It should depend on adapter and contract only
		expect(source).toContain('from "./daemon_session_adapter.js"');
		expect(source).toContain('from "./control_plane_contract.js"');
	});

	test("server_runtime composes thin-host boundary and session adapter", async () => {
		const source = await readFile(serverRuntimePath, "utf8");

		// Runtime should import session adapter and thin-host
		expect(source).toContain('from "./daemon_session_adapter.js"');
		expect(source).toContain('from "./daemon_thin_host.js"');

		// Runtime capabilities should declare boundary
		expect(source).toContain("boundary");
		expect(source).toContain("DAEMON_THIN_BOUNDARY");
	});
});
