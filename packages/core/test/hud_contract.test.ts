import { expect, test } from "bun:test";
import {
	applyHudStylePreset,
	HUD_CONTRACT_VERSION,
	hudStylePresetWarnings,
	HudDocSchema,
	normalizeHudDocs,
	parseHudDoc,
	resolveHudStylePresetName,
	serializeHudDocTextFallback,
	serializeHudDocsTextFallback,
	stableSerializeJson,
} from "@femtomc/mu-core";

function mkHudDoc(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		v: HUD_CONTRACT_VERSION,
		hud_id: "planning",
		title: "Planning",
		scope: null,
		chips: [
			{
				key: "phase",
				label: "reviewing",
				tone: "warning",
			},
		],
		sections: [
			{
				kind: "checklist",
				title: "Steps",
				items: [
					{ id: "1", label: "Investigate", done: true },
					{ id: "2", label: "Draft", done: false },
				],
			},
		],
		actions: [{ id: "refresh", label: "Refresh", command_text: "/mu hud snapshot", kind: "secondary" }],
		snapshot_compact: "HUD(plan) · phase=reviewing",
		snapshot_multiline: "Planning HUD snapshot",
		updated_at_ms: 123,
		metadata: {},
		...overrides,
	};
}

test("HudDoc schema accepts valid documents", () => {
	const doc = HudDocSchema.parse(mkHudDoc());
	expect(doc.v).toBe(HUD_CONTRACT_VERSION);
	expect(doc.hud_id).toBe("planning");
	expect(doc.sections).toHaveLength(1);
});

test("HudDoc schema accepts optional presentation style hints", () => {
	const doc = HudDocSchema.parse(
		mkHudDoc({
			title_style: { weight: "strong", italic: true },
			chips: [{ key: "phase", label: "review", tone: "warning", style: { weight: "normal", italic: true } }],
			sections: [
				{
					kind: "kv",
					title: "Status",
					title_style: { italic: true },
					items: [
						{
							key: "next",
							label: "next_action",
							value: "Ship styling",
							tone: "accent",
							value_style: { code: true },
						},
					],
				},
				{
					kind: "checklist",
					title: "Checklist",
					items: [{ id: "1", label: "Render", done: false, style: { italic: true } }],
				},
				{
					kind: "text",
					title: "Summary",
					text: "Done",
					tone: "success",
					style: { weight: "strong" },
				},
			],
			actions: [
				{ id: "snapshot", label: "Snapshot", command_text: "/mu hud snapshot", kind: "secondary", style: { italic: true } },
			],
			snapshot_style: { code: true, italic: true },
		}),
	);
	expect(doc.title_style?.italic).toBe(true);
	expect(doc.snapshot_style?.code).toBe(true);
	const section = doc.sections[0];
	if (section?.kind !== "kv") {
		throw new Error("expected first section to be kv");
	}
	expect(section.items[0]?.value_style?.code).toBe(true);
});

test("HudDoc schema rejects unknown fields", () => {
	const invalid = {
		...mkHudDoc(),
		unexpected: true,
	};
	expect(() => HudDocSchema.parse(invalid)).toThrow();
});

test("stableSerializeJson canonicalizes key ordering deterministically", () => {
	const serialized = stableSerializeJson({ z: 1, a: { d: 4, c: 3 }, arr: [{ z: 2, y: 1 }] });
	expect(serialized).toBe('{"a":{"c":3,"d":4},"arr":[{"y":1,"z":2}],"z":1}');
});

test("normalizeHudDocs deduplicates by hud_id and keeps latest updated_at_ms", () => {
	const docs = normalizeHudDocs([
		mkHudDoc({ hud_id: "subagents", updated_at_ms: 10 }),
		mkHudDoc({ hud_id: "planning", updated_at_ms: 40, title: "Planning latest" }),
		mkHudDoc({ hud_id: "planning", updated_at_ms: 20, title: "Planning stale" }),
		{ hud_id: "invalid" },
	]);

	expect(docs).toHaveLength(2);
	expect(docs[0]?.hud_id).toBe("planning");
	expect(docs[0]?.title).toBe("Planning latest");
	expect(docs[1]?.hud_id).toBe("subagents");
});

test("parseHudDoc returns null for invalid inputs", () => {
	expect(parseHudDoc({ nope: true })).toBeNull();
	expect(parseHudDoc(mkHudDoc({ title: "ok" }))?.title).toBe("ok");
});

test("resolveHudStylePresetName reads known preset names from doc metadata", () => {
	expect(resolveHudStylePresetName(mkHudDoc({ metadata: { style_preset: "planning" } }))).toBe("planning");
	expect(resolveHudStylePresetName(mkHudDoc({ metadata: { style_preset: "subagents" } }))).toBe("subagents");
	expect(resolveHudStylePresetName(mkHudDoc({ metadata: { style_preset: "unknown" } }))).toBeNull();
	expect(resolveHudStylePresetName({ nope: true })).toBeNull();
});

test("applyHudStylePreset derives style hints while preserving explicit overrides", () => {
	const planningDoc = mkHudDoc({
		metadata: { style_preset: "planning" },
		sections: [
			{
				kind: "kv",
				title: "Status",
				items: [{ key: "root", label: "root", value: "mu-root-123" }],
			},
		],
		actions: [{ id: "snapshot", label: "Snapshot", command_text: "/mu hud snapshot", kind: "secondary" }],
		title_style: { weight: "normal" },
	});
	const styled = applyHudStylePreset(planningDoc);
	if (!styled) {
		throw new Error("expected styled doc");
	}
	expect(styled.title_style?.weight).toBe("normal");
	expect(styled.snapshot_style?.italic).toBe(true);
	expect(styled.chips[0]?.style?.weight).toBe("strong");
	const section = styled.sections[0];
	if (section?.kind !== "kv") {
		throw new Error("expected kv section");
	}
	expect(section.title_style?.weight).toBe("strong");
	expect(section.items[0]?.value_style?.code).toBe(true);
	expect(styled.actions[0]?.style?.italic).toBe(true);

	const unchanged = applyHudStylePreset(mkHudDoc({ metadata: { style_preset: "unknown" } }));
	expect(unchanged?.title_style).toBeUndefined();
});

test("hudStylePresetWarnings returns advisory guidance for preset/document mismatches", () => {
	const warnings = hudStylePresetWarnings(
		mkHudDoc({
			hud_id: "subagents",
			chips: [],
			sections: [{ kind: "text", text: "noop" }],
			metadata: { style_preset: "planning" },
		}),
	);
	expect(warnings.length).toBeGreaterThan(0);
	expect(warnings.some((warning) => warning.includes("expects hud_id=planning"))).toBe(true);
	expect(warnings.some((warning) => warning.includes("recommends a checklist section"))).toBe(true);

	const none = hudStylePresetWarnings(mkHudDoc({ metadata: {} }));
	expect(none).toEqual([]);
});

test("serializeHudDocTextFallback renders deterministic compact and multiline text", () => {
	const doc = mkHudDoc({
		title: "Planning HUD",
		scope: "mu-root-123",
		chips: [
			{ key: "phase", label: "phase:reviewing" },
			{ key: "steps", label: "steps:2/5" },
		],
		sections: [
			{
				kind: "kv",
				title: "Status",
				items: [
					{ key: "root", label: "root", value: "mu-root-123" },
					{ key: "waiting", label: "waiting_on_user", value: "yes" },
				],
			},
			{
				kind: "checklist",
				title: "Checklist",
				items: [
					{ id: "1", label: "Investigate", done: true },
					{ id: "2", label: "Draft", done: false },
				],
			},
		],
		actions: [
			{ id: "snapshot", label: "Snapshot", command_text: "/mu hud snapshot", kind: "secondary" },
			{ id: "next", label: "Next", command_text: "/mu status", kind: "primary" },
		],
		snapshot_compact: "phase=reviewing · steps=2/5",
	});

	expect(serializeHudDocTextFallback(doc, { mode: "compact" })).toBe(
		"Planning HUD · phase=reviewing · steps=2/5",
	);
	expect(serializeHudDocTextFallback(doc, { mode: "multiline" })).toBe(
		[
			"Planning HUD [planning]",
			"scope: mu-root-123",
			"chips: phase:reviewing · steps:2/5",
			"section: kv (Status)",
			"- root: mu-root-123",
			"- waiting_on_user: yes",
			"section: checklist (Checklist)",
			"- [x] Investigate",
			"- [ ] Draft",
			"actions:",
			"- Snapshot: /mu hud snapshot",
			"- Next: /mu status",
		].join("\n"),
	);
});

test("serializeHudDocsTextFallback keeps canonical ordering and deterministic truncation", () => {
	const planning = mkHudDoc({
		hud_id: "planning",
		title: "Planning HUD",
		updated_at_ms: 300,
		actions: Array.from({ length: 6 }, (_, idx) => ({
			id: `a-${idx}`,
			label: `Action ${idx}`,
			command_text: `/mu hud snapshot ${idx}`,
		})),
	});
	const subagents = mkHudDoc({
		hud_id: "subagents",
		title: "Subagents HUD",
		snapshot_compact: "mode=operator · ready=3 · active=2",
		sections: [
			{
				kind: "activity",
				title: "Activity",
				lines: ["alpha", "beta", "gamma", "delta"],
			},
		],
		updated_at_ms: 200,
	});

	const compact = serializeHudDocsTextFallback([subagents, planning], { mode: "compact" });
	expect(compact).toContain("Planning HUD · HUD(plan) · phase=reviewing");
	expect(compact).toContain("Subagents HUD · mode=operator · ready=3 · active=2");
	expect(compact.indexOf("Planning HUD")).toBeLessThan(compact.indexOf("Subagents HUD"));

	const multiline = serializeHudDocsTextFallback([subagents, planning], {
		mode: "multiline",
		maxSectionItems: 2,
		maxActions: 3,
	});
	expect(multiline).toContain("… (+2 more)");
	expect(multiline).toContain("… (+3 more)");
});
