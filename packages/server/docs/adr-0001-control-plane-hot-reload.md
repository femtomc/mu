# ADR-0001: Generation-supervised control-plane hot reload

- **Status:** Accepted
- **Date:** 2026-02-17
- **Related endpoints:** `/api/control-plane/reload`, `/api/control-plane/rollback`, `/api/status`

## Context

`mu` originally supported an in-process control-plane remount via
`POST /api/control-plane/reload`, but the flow was effectively a single swap
without explicit generation ownership, overlap/drain semantics, or structured
rollback telemetry.

This made operational debugging harder and left adapter handoff behavior
implicit under concurrent requests.

## Decision

Adopt a generation-scoped hot-reload architecture with explicit lifecycle
control:

1. **Control-plane generation supervisor**
   - Every reload attempt gets a generation identity (`generation_id`,
     `generation_seq`) and reload attempt identity (`attempt_id`).
   - Concurrent reload calls are coalesced to the same in-flight attempt.

2. **Lifecycle observability**
   - Warmup/cutover/drain/rollback transitions are emitted through
     `GenerationTelemetryRecorder`.
   - Queue duplicate/drop signals are recorded with generation tags.

3. **Telegram blue/green generation manager**
   - Keep durable services (runtime, command pipeline, outbox) stable.
   - Treat telegram adapter runtime as generation-scoped and reloadable.
   - Enforce warmup gate, cutover activation, bounded drain, and explicit
     rollback triggers.

4. **Explicit rollback control**
   - Add `POST /api/control-plane/rollback` as an operator-facing, explicit
     rollback trigger through the same reload pipeline.

## Operator-facing payloads

### `/api/control-plane/reload`

Returns generation-scoped outcome metadata:

- `generation`: attempt identity, coalescing flag, from/to/active generation,
  and outcome.
- `telegram_generation`: warmup/cutover/drain/rollback detail when telegram
  generation handling is active.

### `/api/status`

`control_plane` now includes:

- `generation`: generation supervisor snapshot (active/pending/last reload)
- `observability.counters`: reload + duplicate/drop counters

This keeps operators aligned with runtime state and recent reload health without
parsing logs.

## Consequences

### Positive

- Clear ownership boundaries: durable kernel components stay stable while
  generation modules reload.
- Safer reload behavior with explicit warmup/cutover/drain/rollback semantics.
- Better operational debugging via structured status + telemetry.

### Trade-offs

- Additional lifecycle state to reason about.
- In-memory telemetry/supervisor snapshots reset on process restart.
- Rollback availability depends on retained previous generation/config.

## Guardrail

Generation-scoped control-plane metadata is now part of the required contract
for both `/api/control-plane/reload` and `/api/status`. Operator/agent clients
must treat missing generation fields as a protocol error instead of silently
continuing with incomplete status payloads.
