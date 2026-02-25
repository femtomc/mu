import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stableSerializeJson, type UiDoc } from "@femtomc/mu-core";
import { readJsonl } from "@femtomc/mu-core/node";
import {
	issueUiDocActionPayloads,
	UiCallbackTokenJournalEntrySchema,
	UiCallbackTokenStore,
} from "@femtomc/mu-control-plane";

function makeUiDoc(): UiDoc {
	return {
		v: 1,
		ui_id: "ui:answer",
		title: "Answer prompt",
		summary: "Choose an option",
		components: [
			{
				kind: "text",
				id: "intro",
				text: "Pick yes or no",
				metadata: {},
			},
		],
		actions: [
			{
				id: "yes",
				label: "Yes",
				payload: {
					zeta: 7,
					alpha: { b: 2, a: 1 },
				},
				metadata: {
					command_text: "/mu answer yes",
					command_callback: "/unsafe yes",
				},
			},
			{
				id: "no",
				label: "No",
				payload: { value: "no" },
				metadata: {
					command_callback: "/unsafe no",
				},
			},
		],
		revision: {
			id: "rev-1",
			version: 1,
		},
		updated_at_ms: 10,
		metadata: {},
	};
}

describe("ui_event_egress helper", () => {
	test("issues callback tokens with strict scope and emits stable sanitized payload JSON", async () => {
		const root = await mkdtemp(join(tmpdir(), "mu-ui-event-egress-"));
		const tokenPath = join(root, "ui_callback_tokens.jsonl");
		const tokenIds = ["tokseed0001", "tokseed0002"];
		const store = new UiCallbackTokenStore(tokenPath, {
			tokenIdGenerator: () => {
				const next = tokenIds.shift();
				if (!next) {
					throw new Error("token generator exhausted");
				}
				return next;
			},
		});
		const uiDoc = makeUiDoc();

		const issued = await issueUiDocActionPayloads({
			uiDocs: [uiDoc],
			tokenStore: store,
			context: {
				channel: "slack",
				channelTenantId: "team-1",
				channelConversationId: "chan-1",
				actorBindingId: "binding-1",
			},
			ttlMs: 30_000,
			nowMs: 1_000,
		});

		expect(issued).toHaveLength(1);
		expect(issued[0]?.callback_token).toBe("mu-ui:tokseed0001");
		expect(issued[0]?.ui_event.metadata.command_text).toBe("/mu answer yes");
		expect((issued[0]?.ui_event.metadata as Record<string, unknown>).command_callback).toBeUndefined();
		expect(issued[0]?.payload_json).toBe(stableSerializeJson(issued[0]?.ui_event));
		expect(issued[0]?.payload_json.indexOf('"alpha"')).toBeLessThan(issued[0]?.payload_json.indexOf('"zeta"'));
		expect(issued[0]?.payload_json.indexOf('"a"')).toBeLessThan(issued[0]?.payload_json.indexOf('"b"'));

		expect(uiDoc.actions[0]?.callback_token).toBeUndefined();
		expect((uiDoc.actions[0]?.metadata as Record<string, unknown>).command_callback).toBe("/unsafe yes");

		const rows = await readJsonl(tokenPath);
		const entries = rows.map((row) => UiCallbackTokenJournalEntrySchema.parse(row));
		const issues = entries.filter((entry) => entry.kind === "issue");
		expect(issues).toHaveLength(1);
		if (issues.length !== 1) {
			throw new Error(`expected 1 issue row, got ${issues.length}`);
		}
		expect(issues[0].scope).toEqual({
			channel: "slack",
			channelTenantId: "team-1",
			channelConversationId: "chan-1",
			actorBindingId: "binding-1",
			uiId: "ui:answer",
			revision: 1,
			actionId: "yes",
		});
		expect(issues[0].record.ui_event.callback_token).toBeUndefined();
		expect((issues[0].record.ui_event.metadata as Record<string, unknown>).command_callback).toBeUndefined();
	});
});
