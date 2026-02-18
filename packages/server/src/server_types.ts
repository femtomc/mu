export type ProgramWakeMode = "immediate" | "next_heartbeat";

export function normalizeWakeMode(value: unknown): ProgramWakeMode {
	if (typeof value !== "string") {
		return "immediate";
	}
	const normalized = value.trim().toLowerCase().replaceAll("-", "_");
	return normalized === "next_heartbeat" ? "next_heartbeat" : "immediate";
}

export function toNonNegativeInt(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.max(0, Math.trunc(value));
	}
	if (typeof value === "string" && /^\d+$/.test(value.trim())) {
		return Math.max(0, Number.parseInt(value, 10));
	}
	return Math.max(0, Math.trunc(fallback));
}
