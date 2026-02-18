import {
	type ControlPlaneOutbox,
	correlationFromCommandRecord,
	type OutboundEnvelope,
	type OutboxRecord,
} from "@femtomc/mu-control-plane";
import type { ControlPlaneRunEvent } from "./run_supervisor.js";

function sha256Hex(input: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(input);
	return hasher.digest("hex");
}

function outboxKindForRunEvent(kind: ControlPlaneRunEvent["kind"]): OutboundEnvelope["kind"] {
	switch (kind) {
		case "run_completed":
			return "result";
		case "run_failed":
			return "error";
		default:
			return "lifecycle";
	}
}

export async function enqueueRunEventOutbox(opts: {
	outbox: ControlPlaneOutbox;
	event: ControlPlaneRunEvent;
	nowMs: number;
}): Promise<OutboxRecord | null> {
	const command = opts.event.command;
	if (!command) {
		return null;
	}

	const baseCorrelation = correlationFromCommandRecord(command);
	const correlation = {
		...baseCorrelation,
		run_root_id: opts.event.run.root_issue_id ?? baseCorrelation.run_root_id,
	};
	const envelope: OutboundEnvelope = {
		v: 1,
		ts_ms: opts.nowMs,
		channel: command.channel,
		channel_tenant_id: command.channel_tenant_id,
		channel_conversation_id: command.channel_conversation_id,
		request_id: command.request_id,
		response_id: `resp-${sha256Hex(`run-event:${opts.event.run.job_id}:${opts.event.seq}:${opts.nowMs}`).slice(0, 20)}`,
		kind: outboxKindForRunEvent(opts.event.kind),
		body: opts.event.message,
		correlation,
		metadata: {
			async_run: true,
			run_event_kind: opts.event.kind,
			run_event_seq: opts.event.seq,
			run: opts.event.run,
		},
	};

	const decision = await opts.outbox.enqueue({
		dedupeKey: `run-event:${opts.event.run.job_id}:${opts.event.seq}`,
		envelope,
		nowMs: opts.nowMs,
		maxAttempts: 6,
	});
	return decision.record;
}
