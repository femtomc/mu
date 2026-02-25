import { UiEventSchema, type UiEvent } from "@femtomc/mu-core";
import {
	UiCallbackTokenScopeSchema,
	type UiCallbackTokenScope,
	type UiCallbackTokenStore,
	type UiCallbackTokenDecodeDecision,
} from "./ui_callback_token_store.js";

export type UiEventContext = {
	channel: string;
	channelTenantId: string;
	channelConversationId: string;
	actorBindingId: string;
};

export function parseUiEventPayload(value: unknown): UiEvent | null {
	if (typeof value !== "string") {
		return null;
	}
	if (value.trim().length === 0) {
		return null;
	}
	try {
		const parsed = JSON.parse(value);
		const maybeEvent = UiEventSchema.safeParse(parsed);
		return maybeEvent.success ? maybeEvent.data : null;
	} catch {
		return null;
	}
}

export function buildUiCallbackScope(context: UiEventContext, event: UiEvent): UiCallbackTokenScope {
	return UiCallbackTokenScopeSchema.parse({
		channel: context.channel,
		channelTenantId: context.channelTenantId,
		channelConversationId: context.channelConversationId,
		actorBindingId: context.actorBindingId,
		uiId: event.ui_id,
		revision: event.revision.version,
		actionId: event.action_id,
	});
}

export function commandTextFromUiEvent(event: UiEvent): string | null {
	const candidate = typeof event.metadata?.command_text === "string" ? event.metadata.command_text.trim() : "";
	if (candidate.length === 0) {
		return null;
	}
	return candidate;
}

export function uiEventForMetadata(event: UiEvent): UiEvent {
	const clone: UiEvent = { ...event };
	if (clone.callback_token) {
		Reflect.deleteProperty(clone, "callback_token");
	}
	return clone;
}

export async function decodeUiEventToken(opts: {
	tokenStore: UiCallbackTokenStore;
	context: UiEventContext;
	uiEvent: UiEvent;
	nowMs: number;
}): Promise<UiCallbackTokenDecodeDecision> {
	const scope = buildUiCallbackScope(opts.context, opts.uiEvent);
	return await opts.tokenStore.decodeAndConsume({
		callbackData: opts.uiEvent.callback_token ?? "",
		scope,
		nowMs: opts.nowMs,
	});
}

export function uiCallbackTokenFailurePayload(decision: UiCallbackTokenDecodeDecision): {
	reason: string;
	text: string;
} {
	switch (decision.kind) {
		case "invalid":
			return {
				reason: `ui_callback_${decision.reason}`,
				text: "This interaction was not recognized.",
			};
		case "expired":
			return {
				reason: "expired_ui_callback_token",
				text: "This interaction expired. Please rerun the request.",
			};
		case "consumed":
			return {
				reason: "consumed_ui_callback_token",
				text: "This interaction was already used.",
			};
		case "scope_mismatch":
			return {
				reason: "ui_callback_scope_mismatch",
				text: "This action is not valid in this context.",
			};
		case "ok":
			return { reason: "ui_callback_ok", text: "" };
	}
}
