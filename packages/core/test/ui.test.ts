import { expect, test } from "bun:test";
import {
	UI_CONTRACT_VERSION,
	normalizeUiDocs,
	parseUiDoc,
	resolveUiStatusProfileName,
	type UiAction,
	UiActionSchema,
	type UiComponentText,
	type UiDoc,
	UiDocSchema,
	uiDocRevisionConflict,
	uiStatusProfileWarnings,
} from "@femtomc/mu-core";

type UiKeyValueComponent = Extract<UiDoc["components"][number], { kind: "key_value" }>;
type UiListComponent = Extract<UiDoc["components"][number], { kind: "list" }>;

function mkComponent(overrides: Partial<UiComponentText> = {}): UiComponentText {
	return {
		kind: "text",
		id: "component:text:1",
		text: "Interactive panel ready",
		metadata: {},
		...overrides,
	};
}

function mkKeyValueComponent(overrides: Partial<UiKeyValueComponent> = {}): UiKeyValueComponent {
	return {
		kind: "key_value",
		id: "component:kv:1",
		rows: [{ key: "phase", value: "drafting" }],
		metadata: {},
		...overrides,
	};
}

function mkListComponent(overrides: Partial<UiListComponent> = {}): UiListComponent {
	return {
		kind: "list",
		id: "component:list:1",
		items: [{ id: "item:1", label: "Investigate" }],
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
	const docLatest = mkUiDoc({
		ui_id: "ui:panel",
		revision: { id: "rev:2", version: 2 },
		title: "Panel latest",
		updated_at_ms: 300,
	});
	const docStale = mkUiDoc({
		ui_id: "ui:panel",
		revision: { id: "rev:1", version: 1 },
		title: "Panel stale",
		updated_at_ms: 200,
	});
	const docOther = mkUiDoc({
		ui_id: "ui:dialog",
		revision: { id: "rev:1", version: 1 },
		title: "Dialog",
		updated_at_ms: 250,
	});
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

test("resolveUiStatusProfileName reads known profile ids from metadata.profile", () => {
	expect(resolveUiStatusProfileName(mkUiDoc({ metadata: { profile: { id: "planning" } } }))).toBe("planning");
	expect(resolveUiStatusProfileName(mkUiDoc({ metadata: { profile: { id: "CONTROL-FLOW" } } }))).toBe("control-flow");
	expect(resolveUiStatusProfileName(mkUiDoc({ metadata: { profile: { id: "unknown" } } }))).toBeNull();
	expect(resolveUiStatusProfileName({ nope: true })).toBeNull();
});

test("uiStatusProfileWarnings returns advisory guidance for status-profile mismatches", () => {
	const warnings = uiStatusProfileWarnings(
		mkUiDoc({
			ui_id: "ui:wrong",
			summary: undefined,
			components: [mkComponent()],
			actions: [mkAction()],
			metadata: { profile: { id: "planning", variant: "status" } },
		}),
	);
	expect(warnings.length).toBeGreaterThan(0);
	expect(warnings.some((warning) => warning.includes("expects ui_id=ui:planning"))).toBe(true);
	expect(warnings.some((warning) => warning.includes("recommends summary"))).toBe(true);
	expect(warnings.some((warning) => warning.includes("recommends metadata.profile.snapshot.compact"))).toBe(true);
	expect(warnings.some((warning) => warning.includes("status docs should omit actions"))).toBe(true);
	expect(warnings.some((warning) => warning.includes("recommends a key_value component"))).toBe(true);
	expect(warnings.some((warning) => warning.includes("recommends a list component"))).toBe(true);

	const none = uiStatusProfileWarnings(
		mkUiDoc({
			ui_id: "ui:planning",
			components: [mkKeyValueComponent(), mkListComponent()],
			actions: [],
			metadata: {
				profile: {
					id: "planning",
					variant: "status",
					snapshot: { compact: "phase=drafting" },
				},
			},
		}),
	);
	expect(none).toEqual([]);
});

test("UiAction schema accepts optional callback metadata", () => {
	const action = UiActionSchema.parse(mkAction({ callback_token: "token-1", description: "description" }));
	expect(action.callback_token).toBe("token-1");
	expect(action.description).toBe("description");
});
