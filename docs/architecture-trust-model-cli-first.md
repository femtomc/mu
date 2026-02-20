# Architecture note: trust model, CLI-first surfaces, and module delta

This note documents the **post-refactor** architecture only.

## 1) Trust model: agent roles are trusted-as-root

mu uses an explicit trust model: `operator`, `orchestrator`, `worker`, and `reviewer`
roles are all treated as **trusted-as-root** in the repository.

- Role prompts and issue-role tags are workflow contracts, not hard security boundaries.
- Sessions use generic tools (`bash`, `read`, `write`, `edit`) and invoke `mu` CLI directly.
- Safety/operability depends on process controls (append-only audit log, serialized mutation locks,
  idempotency guards), not a privileged mutation gateway layer.

## 2) Server scope: control-plane infrastructure only

`mu-server` is scoped to control-plane and channel/frontend infrastructure:

- transport + webhook ingress (`/webhooks/*`)
- session coordination (`/api/control-plane/turn`)
- run coordination + wake scheduling (`/api/control-plane/runs*`, `/api/heartbeats*`, `/api/cron*`)
- memory-index background maintenance (scheduler-owned, configured via `control_plane.memory_index`)
- config/control-plane lifecycle + discovery (`/api/control-plane/config`, `/api/control-plane/*`, `/api/control-plane/identities*`)
- observability (`/api/control-plane/events*`, `/api/control-plane/status`)

Heartbeats/cron remain server-owned runtime scheduling concerns because they
require a long-lived timer loop and now dispatch operator wake turns
(context injection + broadcast of the resulting operator reply).

It is **not** a privileged business-logic gateway for issue/forum/context stores.

Removed gateway surfaces:

- `/api/commands/submit`
- `/api/query`
- `/api/issues*`
- `/api/forum*`
- `/api/context*`
- `/api/session-flash*`
- `/api/session-turn` (re-homed under `/api/control-plane/turn`)

## 3) CLI-first command surfaces (replacement for query/command split)

Read/query workflows are direct CLI commands:

- `mu status`
- `mu issues list|get|ready|children|validate`
- `mu forum read|topics`
- `mu events list|trace`
- `mu runs list|get|trace`
- `mu heartbeats list|get`
- `mu cron stats|list|get`
- `mu memory search|timeline|stats`
- `mu memory index status|rebuild`
- `mu control status|identities`

Mutations are also direct CLI commands:

- `mu issues create|update|claim|open|close|dep|undep`
- `mu forum post`
- `mu runs start|resume|interrupt`
- `mu heartbeats create|update|delete|trigger|enable|disable`
- `mu cron create|update|delete|trigger|enable|disable`
- `mu turn --session-id ... --body ...`
- `mu control link|unlink|reload|update`

Agent/operator default workflow is now: **generic tools + `bash("mu ...")`**.

## 4) Concise removed-vs-added module summary

| Removed | Added / replacement |
| --- | --- |
| `packages/agent/src/extensions/query.ts` | CLI-first role prompts + direct `bash("mu ...")` usage |
| `packages/agent/src/extensions/operator-command.ts` | Generic tool model (no dedicated query/command wrapper split) |
| `packages/agent/src/extensions/mu-tools.ts` | `packages/agent/src/extensions/index.ts` now uses empty worker/orchestrator extension tool lists |
| `packages/server/src/api/issues.ts` | Server route scope reduced to control-plane/session/transport routes |
| `packages/server/src/api/forum.ts` | Server no longer fronts forum business APIs |
| `packages/server/src/api/context.ts` | Context retrieval moved to CLI-first `mu memory ...` surface |
| Legacy query/command gateway route handling in `packages/server/src/server_routing.ts` | Explicit control-plane-only routing + 404 coverage for removed routes |

Additional architecture-coverage additions:

- `packages/server/test/control_plane_scope.test.ts`
- `packages/control-plane/test/direct_cli_integrity_primitives.test.ts`
- `packages/agent/test/role_prompts_cli_first.test.ts`

## 5) Follow-up risks (deferred)

1. **Neovim tail endpoint drift**
   - `packages/neovim/lua/mu/init.lua` still targets `/api/context/timeline` for tail polling.
   - Risk: `:Mu tail ...` behavior can regress because control-plane-only server scope removes `/api/context*` routes.

2. **High blast radius under trusted-as-root**
   - By design, role separation is not a security boundary.
   - Risk: prompt/operator mistakes can execute destructive commands unless disciplined by workflow and review.

3. **Command-surface documentation drift**
   - CLI grows quickly (`events/runs/heartbeats/cron/context/turn`).
   - Risk: static docs become stale unless kept in lockstep with command help output/tests.
