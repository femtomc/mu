# Programmable UI substrate

Interactive UI documents (`UiDoc`) let skills publish user-facing interaction state that survives
session reconnects and routes actions back into normal operator turns.

## UX contract (what is and is not product flow)

`mu_ui` is **agent-driven**:

1. Skills publish docs/actions.
2. Users interact through their channel surface (Slack/Discord/Telegram/Neovim).
3. The adapter converts that interaction into command text (for example `/answer yes`) and sends
   it through the same turn pipeline as any other inbound command.

`/mu ui run` is available in the terminal operator UI, but it is a **debug/helper path**. It is
not required in product/reference end-user flows.

## Reference `/answer` flow (mu_ui-only)

1. **Skill emits a `UiDoc`** via `mu_ui` with actions carrying
   `metadata.command_text` (for example `/answer yes`, `/answer no`).
2. **Adapter egress tokenizes actions** (single-use callback token scoped to channel/tenant/
   conversation/actor binding/ui/action/revision).
3. **User triggers action in-channel** (button/tap/frontend event).
4. **Adapter ingress validates token + scope**, reconstructs a `UiEvent`, derives command text,
   and injects it as normal inbound command text.
5. **Skill handles `/answer <choice>`** and clears/removes the doc (`mu_ui remove|clear`).

No bespoke per-flow extension logic is required when this contract is followed.

## Compatibility cleanup and migration notes

### Removed in this cleanup pass

- **Synthetic `/mu ui_event <ui>/<action>` command fallback** was removed from egress/ingress paths.
  Interactive action routing now requires explicit `metadata.command_text`.
- **Terminal `/mu ui run` `MU_UI_EVENT ...` fallback dispatch** was removed.
  If an action is missing `metadata.command_text`, the operator UI now warns and does not send an implicit payload.
- **Discord ingress legacy JSON `custom_id` decode fallback** was removed.
  Discord component callbacks must use compact tokenized payload format.
- **Frontend ingress `text` alias for `command_text`** was removed.
  Frontend command ingress now requires `command_text` (unless `ui_event` is provided).
- **Telegram callback token prefix `mu1:`** was removed.
  Telegram callback tokens now use the unified `mu-ui:` prefix.

### Migration requirement

For all new interactive `UiDoc` actions, set `action.metadata.command_text` explicitly.
Actions without `metadata.command_text` are treated as non-interactive fallback rows.

## Channel action support and degrade matrix

| Surface | Component rendering | Action support | Degrade behavior |
| --- | --- | --- | --- |
| Slack | Rich block rendering for `text`, `list`, `key_value`, `divider` | Block buttons backed by scoped callback tokens (`mu-ui:*`) | If token issuance/payload cannot be used, action lines are rendered as deterministic text in-message |
| Discord | Text projection of `UiDoc` content | Discord button components with compact tokenized `custom_id` payload | If token issuance/size limits fail, deterministic `Actions:` text is appended with command text |
| Telegram | Text projection in `sendMessage` body | Inline keyboard callbacks using encoded callback tokens (`mu-ui:*`) | If callback encoding unavailable/overflow, deterministic `Actions:` command-text lines are appended |
| Neovim frontend | Frontend receives canonical `ui_docs` payload (default renderer is text-first) | Actions include `callback_token`; frontend sends `ui_event` payload back | Missing/invalid/expired token returns deterministic rejection; user can still send command text manually |
| Terminal API channel (`channel=terminal`) | Text-only | **Unsupported** (`ui_actions_not_implemented`) | Use Slack/Discord/Telegram/Neovim for interactive action clicks |
| Terminal operator UI (`mu serve`) | Local preview + interaction dialog | `/mu ui run` or `Ctrl+Alt+U` dispatches action command text/UI event | Debug/helper path only; not required for user-facing flows |

To inspect live capability flags, query:

```bash
curl -s http://localhost:3000/api/control-plane/channels | jq '.channels[] | {channel, ui}'
```

## Session state and revisions

- UI state is scoped by operator session ID and retained for 30 minutes after last access.
- Publish updates with incremented `revision.version`.
- `normalizeUiDocs(...)` keeps highest-version docs per `ui_id` deterministically.
- Close docs explicitly with `mu_ui remove` or `mu_ui clear`.

## Intentionally unsupported paths (current)

1. **`/mu ui run` as primary end-user UX** — unsupported by design.
   - Rationale: end-user interaction should be channel-native and agent-driven.
   - Roadmap note: no plan to make `/mu ui run` a required user path; it remains operator debug tooling.

2. **Rich non-text component parity on Discord/Telegram/Neovim** — not implemented yet.
   - Rationale: current baseline prioritizes deterministic cross-channel behavior and reliable action transport.
   - Roadmap note: add richer renderers per channel without changing the `UiEvent`/token contract.

3. **Interactive actions on terminal API channel (`channel=terminal`)** — unsupported.
   - Rationale: terminal channel currently has no remote callback transport contract.
   - Roadmap note: evaluate tokenized terminal action transport after channel auth/transport hardening.

## Operator debugging commands

Use these when diagnosing UI state:

- `/mu ui status`
- `/mu ui snapshot [compact|multiline]`
- `/mu ui run [ui-id]` (debug/helper only)
