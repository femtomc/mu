import { expect, test } from "bun:test";
import {
	HUD_CONTRACT_VERSION,
	HudRuntime,
	type HudDocV1,
	stableSerializeJson,
	type HudProvider,
} from "@femtomc/mu-core";

type CounterMessage = { kind: "inc" } | { kind: "set"; value: number };
type CounterEffect = { kind: "inc_later" };

type CounterState = {
	value: number;
};

function counterProvider(id = "counter"): HudProvider<CounterState, CounterMessage, CounterEffect> {
	return {
		id,
		initialState: () => ({ value: 0 }),
		reduce: (state, message) => {
			if (message.kind === "set") {
				return { state: { value: message.value } };
			}
			if (state.value === 0) {
				return { state: { value: 1 }, effects: [{ kind: "inc_later" }] };
			}
			return { state: { value: state.value + 1 } };
		},
		runEffect: (effect, api) => {
			if (effect.kind === "inc_later") {
				api.dispatch({ kind: "inc" });
			}
		},
		view: (state) => mkDoc(id, `value=${state.value}`, state.value),
	};
}

function mkDoc(hudId: string, compact: string, updatedAtMs: number): HudDocV1 {
	return {
		v: HUD_CONTRACT_VERSION,
		hud_id: hudId,
		title: hudId,
		scope: null,
		chips: [],
		sections: [],
		actions: [],
		snapshot_compact: compact,
		updated_at_ms: updatedAtMs,
		metadata: {},
	};
}

test("runtime register/unregister/list provider lifecycle", () => {
	const runtime = new HudRuntime();
	runtime.register(counterProvider("planning"));
	runtime.register(counterProvider("subagents"));

	expect(runtime.listProviders()).toEqual(["planning", "subagents"]);
	expect(runtime.unregister("planning")).toBe(true);
	expect(runtime.unregister("planning")).toBe(false);
	expect(runtime.listProviders()).toEqual(["subagents"]);
});

test("runtime dispatch executes reducer + effects deterministically", async () => {
	const run = async () => {
		const runtime = new HudRuntime();
		runtime.register(counterProvider());
		await runtime.dispatch("counter", { kind: "inc" });
		const second = await runtime.dispatch("counter", { kind: "inc" });
		return second;
	};

	const a = await run();
	const b = await run();

	expect(a.messages_processed).toBe(1);
	expect(a.effects_processed).toBe(0);
	expect(a.hud_docs[0]?.snapshot_compact).toBe("value=3");
	expect(stableSerializeJson(a)).toBe(stableSerializeJson(b));
});

test("runtime emits view snapshots to listeners", async () => {
	const runtime = new HudRuntime();
	const snapshots: string[] = [];
	runtime.subscribe((snapshot) => {
		snapshots.push(snapshot.hud_docs.map((doc) => doc.snapshot_compact).join(","));
	});

	runtime.register(counterProvider("planning"));
	await runtime.dispatch("planning", { kind: "set", value: 4 });

	expect(snapshots).toEqual(["value=0", "value=4"]);
});

test("runtime stays provider-neutral across different message/effect models", async () => {
	type ToggleMessage = { kind: "flip" };
	type ToggleState = { enabled: boolean };
	const toggleProvider: HudProvider<ToggleState, ToggleMessage, never> = {
		id: "toggle",
		initialState: () => ({ enabled: false }),
		reduce: (state) => ({ state: { enabled: !state.enabled } }),
		view: (state) => mkDoc("toggle", `enabled=${state.enabled ? "yes" : "no"}`, state.enabled ? 1 : 0),
	};

	const runtime = new HudRuntime();
	runtime.register(toggleProvider);
	const result = await runtime.dispatch("toggle", { kind: "flip" });
	expect(result.hud_docs[0]?.snapshot_compact).toBe("enabled=yes");
});
