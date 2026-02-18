import type { IdentityBinding } from "./identity_store.js";
import type { InboundEnvelope } from "./models.js";

export type MessagingOperatorRejectReason =
	| "operator_disabled"
	| "operator_action_disallowed"
	| "operator_invalid_output"
	| "context_missing"
	| "context_ambiguous"
	| "context_unauthorized"
	| "cli_validation_failed";

export type MessagingOperatorDecision =
	| {
			kind: "response";
			message: string;
			operatorSessionId: string;
			operatorTurnId: string;
	  }
	| {
			kind: "command";
			commandText: string;
			operatorSessionId: string;
			operatorTurnId: string;
	  }
	| {
			kind: "reject";
			reason: MessagingOperatorRejectReason;
			details?: string;
			operatorSessionId: string;
			operatorTurnId: string;
	  };

export interface MessagingOperatorRuntimeLike {
	handleInbound(opts: {
		inbound: InboundEnvelope;
		binding: IdentityBinding;
	}): Promise<MessagingOperatorDecision>;
	stop?(): Promise<void>;
}
