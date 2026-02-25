# Programmable UI substrate

Interactive UI documents (`UiDoc`) let skills publish user-facing interaction state that survives
session reconnects and routes actions back into normal operator turns.

## UX contract (what is and is not product flow)

`mu_ui` is **agent-driven**:

1. Skills publish docs/actions.
2. Users interact through their channel surface (Slack/Discord/Telegram/Neovim).
3. The adapter converts that interaction into command text (for example `/answer yes`) and sends
   it through the same turn pipeline as any other inbound command.

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

## Action transport requirements

For interactive `UiDoc` actions:

- Set `action.metadata.command_text` explicitly.
- Use callback-token transport (`mu-ui:*`) for channel action execution.
- Treat terminal operator UI (`mu serve`) as preview/inspection only; execute actions through channel-native callbacks.

Actions without `metadata.command_text` are rendered as deterministic non-interactive fallback rows.

## Channel action support and degrade matrix

| Surface | Component rendering | Action support | Degrade behavior |
| --- | --- | --- | --- |
| Slack | Rich block rendering for `text`, `list`, `key_value`, `divider` | Block buttons backed by scoped callback tokens (`mu-ui:*`) | If token issuance/payload cannot be used, action lines are rendered as deterministic text in-message |
| Discord | Text projection of `UiDoc` content | Discord button components with compact tokenized `custom_id` payload | If token issuance/size limits fail, deterministic `Actions:` text is appended with command text |
| Telegram | Text projection in `sendMessage` body | Inline keyboard callbacks using encoded callback tokens (`mu-ui:*`) | If callback encoding unavailable/overflow, deterministic `Actions:` command-text lines are appended |
| Neovim frontend | Frontend receives canonical `ui_docs` payload (default renderer is text-first) | Actions include `callback_token`; frontend sends `ui_event` payload back | Missing/invalid/expired token returns deterministic rejection; user can still send command text manually |
| Terminal API channel (`channel=terminal`) | Text-only | **Unsupported** (`ui_actions_not_implemented`) | Use Slack/Discord/Telegram/Neovim for interactive action clicks |
| Terminal operator UI (`mu serve`) | Local preview/status widget | Not supported (no local action-dispatch command/shortcut) | Use channel-native actions or type command text manually |

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

1. **Local terminal action dispatch** — unsupported.
   - Rationale: interactive action execution is channel-native and callback-token scoped.
   - Roadmap note: keep terminal operator UI as preview/status surface; execute actions via messaging/frontends.

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
