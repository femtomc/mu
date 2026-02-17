import { join } from "node:path";

export type ControlPlanePaths = {
	repoRoot: string;
	controlPlaneDir: string;
	commandsPath: string;
	idempotencyPath: string;
	identitiesPath: string;
	policyPath: string;
	outboxPath: string;
	adapterAuditPath: string;
	writerLockPath: string;
};

export function getControlPlanePaths(repoRoot: string): ControlPlanePaths {
	const controlPlaneDir = join(repoRoot, ".mu", "control-plane");
	return {
		repoRoot,
		controlPlaneDir,
		commandsPath: join(controlPlaneDir, "commands.jsonl"),
		idempotencyPath: join(controlPlaneDir, "idempotency.jsonl"),
		identitiesPath: join(controlPlaneDir, "identities.jsonl"),
		policyPath: join(controlPlaneDir, "policy.json"),
		outboxPath: join(controlPlaneDir, "outbox.jsonl"),
		adapterAuditPath: join(controlPlaneDir, "adapter_audit.jsonl"),
		writerLockPath: join(controlPlaneDir, "writer.lock"),
	};
}
