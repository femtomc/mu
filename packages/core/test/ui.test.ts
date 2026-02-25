import { expect, test } from "bun:test";
import {
	UiAction,
	UiActionSchema,
	UiComponentText,
	UiDoc,
	UiDocSchema,
	UI_CONTRACT_VERSION,
	parseUiDoc,
	normalizeUiDocs,
	uiDocRevisionConflict,
} from "@femtomc/mu-core";

function mkComponent(overrides: Partial<UiComponentText> = {}): UiComponentText {
	return {
		kind: "text",
		id: "component:text:1",
		text: "Interactive panel ready",
		metadata: {},
		...overrides,
	};
}

function mkAction(overrides: Partial<UiAction> = {}): UiAction {
	return {
		id: "action:submit",
		label: "Submit",
		kind: "primary",
		payload: {},
		metadata: {},
		...overrides,
	};
}

function mkUiDoc(overrides: Partial<UiDoc> = {}): UiDoc {
	return {
		v: UI_CONTRACT_VERSION,
		ui_id: "ui:panel",
		title: "Interactive Panel",
		summary: "Current prompt",
		components: [mkComponent()],
		actions: [mkAction()],
		revision: { id: "rev:1", version: 1 },
		updated_at_ms: 123,
		metadata: {},
		...overrides,
	};
}

test("UiDoc schema accepts a valid document", () => {
	const doc = UiDocSchema.parse(mkUiDoc());
	expect(doc.v).toBe(UI_CONTRACT_VERSION);
	expect(doc.components).toHaveLength(1);
	expect(doc.actions?.[0]?.label).toBe("Submit");
});

test("parseUiDoc handles invalid and valid inputs", () => {
	expect(parseUiDoc({ ui_id: "missing" })).toBeNull();
	expect(parseUiDoc(mkUiDoc())?.ui_id).toBe("ui:panel");
});

test("normalizeUiDocs deduplicates preserved docs with highest revision", () => {
	const docLatest = mkUiDoc({ ui_id: "ui:panel", revision: { id: "rev:2", version: 2 }, title: "Panel latest", updated_at_ms: 300 });
	const docStale = mkUiDoc({ ui_id: "ui:panel", revision: { id: "rev:1", version: 1 }, title: "Panel stale", updated_at_ms: 200 });
	const docOther = mkUiDoc({ ui_id: "ui:dialog", revision: { id: "rev:1", version: 1 }, title: "Dialog", updated_at_ms: 250 });
	const normalized = normalizeUiDocs([docLatest, docStale, docOther, { invalid: true }], { maxDocs: 2 });
	expect(normalized).toHaveLength(2);
	expect(normalized[0]?.ui_id).toBe("ui:dialog");
	expect(normalized[1]?.ui_id).toBe("ui:panel");
	expect(normalized[1]?.title).toBe("Panel latest");
});

test("uiDocRevisionConflict detects identical revisions with divergent payloads", () => {
	const base = mkUiDoc();
	const identical = mkUiDoc();
	const conflict = mkUiDoc({ summary: "Different" });
	const bumped = mkUiDoc({ revision: { id: "rev:2", version: 2 } });
	expect(uiDocRevisionConflict(base, identical)).toBe(false);
	expect(uiDocRevisionConflict(base, conflict)).toBe(true);
	expect(uiDocRevisionConflict(base, bumped)).toBe(false);
});

test("UiAction schema accepts optional callback metadata", () => {
	const action = UiActionSchema.parse(mkAction({ callback_token: "token-1", description: "description" }));
	expect(action.callback_token).toBe("token-1");
	expect(action.description).toBe("description");
});
