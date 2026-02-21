import { getStorePaths } from "@femtomc/mu-core/node";
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
	attachmentIndexPath: string;
	attachmentBlobRootDir: string;
};

export function getControlPlanePaths(repoRoot: string): ControlPlanePaths {
	const store = getStorePaths(repoRoot);
	const controlPlaneDir = join(store.storeDir, "control-plane");
	return {
		repoRoot: store.repoRoot,
		controlPlaneDir,
		commandsPath: join(controlPlaneDir, "commands.jsonl"),
		idempotencyPath: join(controlPlaneDir, "idempotency.jsonl"),
		identitiesPath: join(controlPlaneDir, "identities.jsonl"),
		policyPath: join(controlPlaneDir, "policy.json"),
		outboxPath: join(controlPlaneDir, "outbox.jsonl"),
		adapterAuditPath: join(controlPlaneDir, "adapter_audit.jsonl"),
		writerLockPath: join(controlPlaneDir, "writer.lock"),
		attachmentIndexPath: join(controlPlaneDir, "attachments", "index.jsonl"),
		attachmentBlobRootDir: join(controlPlaneDir, "attachments", "blobs"),
	};
}
