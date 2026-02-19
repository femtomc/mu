import {
	applyMuConfigPatch,
	getMuConfigPath,
	muConfigPresence,
	redactMuConfigSecrets,
} from "../config.js";
import type { ServerRoutingDependencies } from "../server_routing.js";

export async function configRoutes(
	request: Request,
	_url: URL,
	deps: ServerRoutingDependencies,
	headers: Headers,
): Promise<Response> {
	if (request.method === "GET") {
		try {
			const config = await deps.loadConfigFromDisk();
			return Response.json(
				{
					repo_root: deps.context.repoRoot,
					config_path: getMuConfigPath(deps.context.repoRoot),
					config: redactMuConfigSecrets(config),
					presence: muConfigPresence(config),
				},
				{ headers },
			);
		} catch (err) {
			return Response.json(
				{ error: `failed to read config: ${deps.describeError(err)}` },
				{ status: 500, headers },
			);
		}
	}

	if (request.method === "POST") {
		let body: { patch?: unknown };
		try {
			body = (await request.json()) as { patch?: unknown };
		} catch {
			return Response.json({ error: "invalid json body" }, { status: 400, headers });
		}

		if (!body || !("patch" in body)) {
			return Response.json({ error: "missing patch payload" }, { status: 400, headers });
		}

		try {
			const base = await deps.loadConfigFromDisk();
			const next = applyMuConfigPatch(base, body.patch);
			const configPath = await deps.writeConfig(deps.context.repoRoot, next);
			return Response.json(
				{
					ok: true,
					repo_root: deps.context.repoRoot,
					config_path: configPath,
					config: redactMuConfigSecrets(next),
					presence: muConfigPresence(next),
				},
				{ headers },
			);
		} catch (err) {
			return Response.json(
				{ error: `failed to write config: ${deps.describeError(err)}` },
				{ status: 500, headers },
			);
		}
	}

	return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
}
