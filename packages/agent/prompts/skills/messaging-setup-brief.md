Set up {{adapter_name}} messaging for mu control-plane.

[Diagnostics]
state: {{state}}
config: {{config_path}}
route: {{route}}
webhook URL: {{webhook_url}}
missing fields: {{missing_fields}}

[Config field status]
{{field_status}}

[Provider setup steps]
{{provider_steps}}

[Instructions]
1) Ask the user ONLY for values you cannot generate: secrets from external providers (e.g. bot tokens from @BotFather), public base URL.
2) Generate values you CAN create yourself (e.g. webhook_secret — run `openssl rand -hex 32` via Bash).
3) Write config via mu_messaging_setup tool: call mu_messaging_setup(action="apply", adapter="{{adapter_id}}", fields={...}) with ALL missing field values. This writes config and reloads the control plane in one step.
4) After config is applied, call provider APIs (e.g. Telegram setWebhook) via Bash/curl.
5) Link an identity binding via mu_identity tool: call mu_identity(action="link", channel="{{adapter_id}}", actor_id="<actor>", tenant_id="<tenant>") — do NOT use `mu control link` CLI.
6) Run {{verify_command}} to confirm everything works.

Do NOT give the user copy-paste commands or tutorials. Do the work yourself.
For identity operations, always use the mu_identity tool (not `mu control link` or direct .mu file access).
