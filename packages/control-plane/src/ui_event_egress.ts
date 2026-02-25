import { stableSerializeJson, type UiAction, type UiDoc, type UiEvent } from "@femtomc/mu-core";
import type { OutboxRecord } from "./outbox.js";
import type { UiCallbackTokenStore } from "./ui_callback_token_store.js";

export const DEFAULT_UI_CALLBACK_TOKEN_TTL_MS = 15 * 60_000;

export type UiActionPayloadContext = {
	channel: string;
	channelTenantId: string;
	channelConversationId: string;
	actorBindingId: string;
};

export type IssuedUiDocActionPayload = {
	key: string;
	ui_id: string;
	action_id: string;
	callback_token: string;
	ui_event: UiEvent;
	payload_json: string;
};

export function uiDocActionPayloadKey(uiId: string, actionId: string): string {
	return `${uiId}:${actionId}`;
}

export function uiActionPayloadContextFromOutboxRecord(record: OutboxRecord): UiActionPayloadContext {
	return {
		channel: record.envelope.channel,
		channelTenantId: record.envelope.channel_tenant_id,
		channelConversationId: record.envelope.channel_conversation_id,
		actorBindingId: record.envelope.correlation.actor_binding_id,
	};
}

function commandTextForAction(action: UiAction): string | null {
	const raw = typeof action.metadata.command_text === "string" ? action.metadata.command_text.trim() : "";
	if (raw.length === 0) {
		return null;
	}
	return raw;
}

export function buildSanitizedUiEventForAction(opts: {
	doc: UiDoc;
	action: UiAction;
	createdAtMs: number;
}): UiEvent | null {
	const commandText = commandTextForAction(opts.action);
	if (!commandText) {
		return null;
	}
	const metadata: Record<string, unknown> = {
		source: "control_plane.ui_doc_action",
		command_text: commandText,
	};
	const event: UiEvent = {
		ui_id: opts.doc.ui_id,
		action_id: opts.action.id,
		revision: { ...opts.doc.revision },
		payload: { ...opts.action.payload },
		created_at_ms: opts.createdAtMs,
		metadata,
	};
	if (opts.action.component_id) {
		event.component_id = opts.action.component_id;
	}
	return event;
}

export async function issueUiDocActionPayloads(opts: {
	uiDocs: readonly UiDoc[];
	tokenStore: UiCallbackTokenStore;
	context: UiActionPayloadContext;
	ttlMs?: number;
	nowMs?: number;
}): Promise<IssuedUiDocActionPayload[]> {
	const nowMs = Math.trunc(opts.nowMs ?? Date.now());
	const ttlMs = Math.trunc(opts.ttlMs ?? DEFAULT_UI_CALLBACK_TOKEN_TTL_MS);
	if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
		throw new Error(`ttlMs must be a positive integer, got ${opts.ttlMs}`);
	}

	const out: IssuedUiDocActionPayload[] = [];
	for (const doc of opts.uiDocs) {
		for (const action of doc.actions) {
			const uiEvent = buildSanitizedUiEventForAction({
				doc,
				action,
				createdAtMs: nowMs,
			});
			if (!uiEvent) {
				continue;
			}
			const record = await opts.tokenStore.issue({
				scope: {
					channel: opts.context.channel,
					channelTenantId: opts.context.channelTenantId,
					channelConversationId: opts.context.channelConversationId,
					actorBindingId: opts.context.actorBindingId,
					uiId: doc.ui_id,
					revision: doc.revision.version,
					actionId: action.id,
				},
				uiEvent,
				ttlMs,
				nowMs,
			});
			const callbackToken = record.callback_data;
			const tokenizedEvent: UiEvent = {
				...uiEvent,
				callback_token: callbackToken,
			};
			out.push({
				key: uiDocActionPayloadKey(doc.ui_id, action.id),
				ui_id: doc.ui_id,
				action_id: action.id,
				callback_token: callbackToken,
				ui_event: tokenizedEvent,
				payload_json: stableSerializeJson(tokenizedEvent),
			});
		}
	}
	return out;
}
