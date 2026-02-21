import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export type MuHudMode = "planning" | "subagents";

let activeHudMode: MuHudMode | null = null;

export function getActiveHudMode(): MuHudMode | null {
	return activeHudMode;
}

export function resetHudMode(): void {
	activeHudMode = null;
}

export function setActiveHudMode(mode: MuHudMode | null): void {
	activeHudMode = mode;
}

export function clearHudMode(mode: MuHudMode): void {
	if (activeHudMode === mode) {
		activeHudMode = null;
	}
}

export function syncHudModeStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) {
		return;
	}
	ctx.ui.setStatus("mu-hud-mode", activeHudMode ? `hud:${activeHudMode}` : undefined);
}
