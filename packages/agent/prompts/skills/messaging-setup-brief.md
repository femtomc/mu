Set up {{adapter_name}} messaging for mu control-plane. You have Bash, Read, Write, and Edit tools — use them to do the setup yourself.

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
3) Use your tools to write the config file directly, call provider APIs (curl via Bash), and complete setup end-to-end.
4) After setup, run {{verify_command}} to confirm everything works.

Do NOT give the user copy-paste commands. Do the work yourself.
