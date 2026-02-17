import type { MuRole } from "./mu_roles.js";

export type BackendRunOpts = {
	issueId: string;
	role: MuRole;
	systemPrompt: string;
	prompt: string;
	provider: string;
	model: string;
	thinking: string;
	cwd: string;
	cli: string;
	logSuffix: string;
	onLine?: (line: string) => void;
	teePath?: string;
};

export interface BackendRunner {
	run(opts: BackendRunOpts): Promise<number>;
}

export function piStreamHasError(line: string): boolean {
	let event: any;
	try {
		event = JSON.parse(line) as any;
	} catch {
		return false;
	}

	const etype = event?.type;
	if (etype === "message_update") {
		const assistantEvent = event?.assistantMessageEvent;
		if (assistantEvent && typeof assistantEvent === "object" && assistantEvent.type === "error") {
			return true;
		}
	}

	if (etype === "message_end") {
		const message = event?.message;
		if (!message || typeof message !== "object") {
			return false;
		}
		if (message.role !== "assistant") {
			return false;
		}
		return message.stopReason === "error" || message.stopReason === "aborted";
	}

	return false;
}
