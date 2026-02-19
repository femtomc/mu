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
- session coordination (`/api/session-flash*`, `/api/session-turn`)
- run/activity/schedule coordination (`/api/runs*`, `/api/activities*`, `/api/heartbeats*`, `/api/cron*`)
- config/control-plane lifecycle + discovery (`/api/config`, `/api/control-plane/*`, `/api/identities*`)
- observability (`/api/events*`, `/api/status`)

Heartbeats/cron remain server-owned runtime scheduling concerns because they
require a long-lived timer loop and coordination with run/activity supervisors.

It is **not** a privileged business-logic gateway for issue/forum/context stores.

Removed gateway surfaces:

- `/api/commands/submit`
- `/api/query`
- `/api/issues*`
- `/api/forum*`
- `/api/context*`

## 3) CLI-first command surfaces (replacement for query/command split)

Read/query workflows are direct CLI commands:

- `mu status`
- `mu issues list|get|ready|children|validate`
- `mu forum read|topics`
- `mu events list|trace`
- `mu runs list|get|trace`
- `mu activities list|get|trace`
- `mu heartbeats list|get`
- `mu cron stats|list|get`
- `mu context search|timeline|stats`
- `mu control status|identities`

Mutations are also direct CLI commands:

- `mu issues create|update|claim|open|close|dep|undep`
- `mu forum post`
- `mu runs start|resume|interrupt`
- `mu heartbeats create|update|delete|trigger|enable|disable`
- `mu cron create|update|delete|trigger|enable|disable`
- `mu session-flash create|ack`
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
| `packages/server/src/api/context.ts` | Context retrieval moved to CLI-first `mu context ...` surface |
| Legacy query/command gateway route handling in `packages/server/src/server_routing.ts` | Explicit control-plane-only routing + 404 coverage for removed routes |

Additional architecture-coverage additions:

- `packages/server/test/control_plane_scope.test.ts`
- `packages/control-plane/test/direct_cli_integrity_primitives.test.ts`
- `packages/agent/test/role_prompts_cli_first.test.ts`

## 5) Follow-up risks (deferred)

1. **Web frontend endpoint drift**
   - `packages/web/src/api.ts` still references removed `/api/issues*` and `/api/forum*` routes.
   - Risk: web UI issue/forum features can regress against control-plane-only server scope.

2. **Neovim tail endpoint drift**
   - `packages/neovim/lua/mu/init.lua` still targets `/api/context/timeline` for tail polling.
   - Risk: `:Mu tail ...` behavior can regress because control-plane-only server scope removes `/api/context*` routes.

3. **High blast radius under trusted-as-root**
   - By design, role separation is not a security boundary.
   - Risk: prompt/operator mistakes can execute destructive commands unless disciplined by workflow and review.

4. **Command-surface documentation drift**
   - CLI grows quickly (`events/runs/activities/heartbeats/cron/context/session-flash/turn`).
   - Risk: static docs become stale unless kept in lockstep with command help output/tests.
