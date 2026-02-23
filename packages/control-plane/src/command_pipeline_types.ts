import type { HudDocV1 } from "@femtomc/mu-core";
import type { IdentityStore } from "./identity_store.js";
import type { MessagingOperatorRuntimeLike } from "./operator_contract.js";
import type { ControlPlaneRuntime } from "./runtime.js";

export type CommandPipelineResult =
	| { kind: "noop"; reason: string }
	| { kind: "invalid"; reason: string }
	| { kind: "operator_response"; message: string; hud_docs?: HudDocV1[] }
	| { kind: "denied"; reason: string };

export type ControlPlaneCommandPipelineOpts = {
	runtime: ControlPlaneRuntime;
	identityStore?: IdentityStore;
	operator?: MessagingOperatorRuntimeLike | null;
	nowMs?: () => number;
};
