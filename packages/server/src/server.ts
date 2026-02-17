import { extname, join, resolve } from "node:path";

import type { EventEnvelope, ForumMessage, Issue, JsonlStore } from "@femtomc/mu-core";
import { currentRunId, EventLog, FsJsonlStore, getStorePaths, JsonlEventSink } from "@femtomc/mu-core/node";
import { ForumStore } from "@femtomc/mu-forum";
import { IssueStore } from "@femtomc/mu-issue";
import { eventRoutes } from "./api/events.js";
import { forumRoutes } from "./api/forum.js";
import { issueRoutes } from "./api/issues.js";
import {
	applyMuConfigPatch,
	DEFAULT_MU_CONFIG,
	getMuConfigPath,
	type MuConfig,
	muConfigPresence,
	readMuConfigFile,
	redactMuConfigSecrets,
	writeMuConfigFile,
} from "./config.js";
import { bootstrapControlPlane, type ControlPlaneConfig, type ControlPlaneHandle } from "./control_plane.js";

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".png": "image/png",
	".jpg": "image/jpeg",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

// Resolve public/ dir relative to this file (works in npm global installs)
const PUBLIC_DIR = join(new URL(".", import.meta.url).pathname, "..", "public");

type ControlPlaneSummary = {
	active: boolean;
	adapters: string[];
	routes: Array<{ name: string; route: string }>;
};

type ControlPlaneReloadResult = {
	ok: boolean;
	reason: string;
	previous_control_plane: ControlPlaneSummary;
	control_plane: ControlPlaneSummary;
	error?: string;
};

type ControlPlaneReloader = (opts: {
	repoRoot: string;
	previous: ControlPlaneHandle | null;
	config: ControlPlaneConfig;
}) => Promise<ControlPlaneHandle | null>;

type ConfigReader = (repoRoot: string) => Promise<MuConfig>;
type ConfigWriter = (repoRoot: string, config: MuConfig) => Promise<string>;

export type ServerOptions = {
	repoRoot?: string;
	port?: number;
	controlPlane?: ControlPlaneHandle | null;
	controlPlaneReloader?: ControlPlaneReloader;
	config?: MuConfig;
	configReader?: ConfigReader;
	configWriter?: ConfigWriter;
};

export type ServerContext = {
	repoRoot: string;
	issueStore: IssueStore;
	forumStore: ForumStore;
	eventLog: EventLog;
	eventsStore: JsonlStore<EventEnvelope>;
};

function describeError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

function summarizeControlPlane(handle: ControlPlaneHandle | null): ControlPlaneSummary {
	if (!handle) {
		return { active: false, adapters: [], routes: [] };
	}
	return {
		active: handle.activeAdapters.length > 0,
		adapters: handle.activeAdapters.map((adapter) => adapter.name),
		routes: handle.activeAdapters.map((adapter) => ({ name: adapter.name, route: adapter.route })),
	};
}

export function createContext(repoRoot: string): ServerContext {
	const paths = getStorePaths(repoRoot);
	const eventsStore = new FsJsonlStore<EventEnvelope>(paths.eventsPath);
	const eventLog = new EventLog(new JsonlEventSink(eventsStore), {
		runIdProvider: currentRunId,
	});

	const issueStore = new IssueStore(new FsJsonlStore<Issue>(paths.issuesPath), { events: eventLog });

	const forumStore = new ForumStore(new FsJsonlStore<ForumMessage>(paths.forumPath), { events: eventLog });

	return { repoRoot, issueStore, forumStore, eventLog, eventsStore };
}

export function createServer(options: ServerOptions = {}) {
	const repoRoot = options.repoRoot || process.cwd();
	const context = createContext(repoRoot);

	const readConfig: ConfigReader = options.configReader ?? readMuConfigFile;
	const writeConfig: ConfigWriter = options.configWriter ?? writeMuConfigFile;
	const fallbackConfig = options.config ?? DEFAULT_MU_CONFIG;

	let controlPlaneCurrent = options.controlPlane ?? null;
	let reloadInFlight: Promise<ControlPlaneReloadResult> | null = null;

	const controlPlaneReloader: ControlPlaneReloader =
		options.controlPlaneReloader ??
		(async ({ repoRoot, config }) => {
			return await bootstrapControlPlane({ repoRoot, config });
		});

	const controlPlaneProxy: ControlPlaneHandle = {
		get activeAdapters() {
			return controlPlaneCurrent?.activeAdapters ?? [];
		},
		async handleWebhook(path, req) {
			const handle = controlPlaneCurrent;
			if (!handle) return null;
			return await handle.handleWebhook(path, req);
		},
		async stop() {
			const handle = controlPlaneCurrent;
			controlPlaneCurrent = null;
			await handle?.stop();
		},
	};

	const loadConfigFromDisk = async (): Promise<MuConfig> => {
		try {
			return await readConfig(context.repoRoot);
		} catch (err) {
			if ((err as { code?: string })?.code === "ENOENT") {
				return fallbackConfig;
			}
			throw err;
		}
	};

	const performControlPlaneReload = async (reason: string): Promise<ControlPlaneReloadResult> => {
		const previous = controlPlaneCurrent;
		const previousSummary = summarizeControlPlane(previous);
		try {
			const latestConfig = await loadConfigFromDisk();
			const next = await controlPlaneReloader({
				repoRoot: context.repoRoot,
				previous,
				config: latestConfig.control_plane,
			});
			controlPlaneCurrent = next;
			if (previous && previous !== next) {
				await previous.stop();
			}
			return {
				ok: true,
				reason,
				previous_control_plane: previousSummary,
				control_plane: summarizeControlPlane(next),
			};
		} catch (err) {
			return {
				ok: false,
				reason,
				previous_control_plane: previousSummary,
				control_plane: summarizeControlPlane(previous),
				error: describeError(err),
			};
		}
	};

	const reloadControlPlane = async (reason: string): Promise<ControlPlaneReloadResult> => {
		if (reloadInFlight) {
			return await reloadInFlight;
		}
		reloadInFlight = performControlPlaneReload(reason).finally(() => {
			reloadInFlight = null;
		});
		return await reloadInFlight;
	};

	const handleRequest = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const path = url.pathname;

		const headers = new Headers({
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type",
		});

		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers });
		}

		if (path === "/healthz" || path === "/health") {
			return new Response("ok", { status: 200, headers });
		}

		if (path === "/api/config") {
			if (request.method === "GET") {
				try {
					const config = await loadConfigFromDisk();
					return Response.json(
						{
							repo_root: context.repoRoot,
							config_path: getMuConfigPath(context.repoRoot),
							config: redactMuConfigSecrets(config),
							presence: muConfigPresence(config),
						},
						{ headers },
					);
				} catch (err) {
					return Response.json(
						{ error: `failed to read config: ${describeError(err)}` },
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
					const base = await loadConfigFromDisk();
					const next = applyMuConfigPatch(base, body.patch);
					const configPath = await writeConfig(context.repoRoot, next);
					return Response.json(
						{
							ok: true,
							repo_root: context.repoRoot,
							config_path: configPath,
							config: redactMuConfigSecrets(next),
							presence: muConfigPresence(next),
						},
						{ headers },
					);
				} catch (err) {
					return Response.json(
						{ error: `failed to write config: ${describeError(err)}` },
						{ status: 500, headers },
					);
				}
			}

			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}

		if (path === "/api/control-plane/reload") {
			if (request.method !== "POST") {
				return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
			}

			let reason = "api_control_plane_reload";
			try {
				const body = (await request.json()) as { reason?: unknown };
				if (typeof body.reason === "string" && body.reason.trim().length > 0) {
					reason = body.reason.trim();
				}
			} catch {
				// ignore invalid body for reason
			}

			const result = await reloadControlPlane(reason);
			return Response.json(result, { status: result.ok ? 200 : 500, headers });
		}

		if (path === "/api/status") {
			const issues = await context.issueStore.list();
			const openIssues = issues.filter((i) => i.status === "open");
			const readyIssues = await context.issueStore.ready();
			const controlPlane = summarizeControlPlane(controlPlaneCurrent);

			return Response.json(
				{
					repo_root: context.repoRoot,
					open_count: openIssues.length,
					ready_count: readyIssues.length,
					control_plane: controlPlane,
				},
				{ headers },
			);
		}

		if (path.startsWith("/api/issues")) {
			const response = await issueRoutes(request, context);
			headers.forEach((value, key) => {
				response.headers.set(key, value);
			});
			return response;
		}

		if (path.startsWith("/api/forum")) {
			const response = await forumRoutes(request, context);
			headers.forEach((value, key) => {
				response.headers.set(key, value);
			});
			return response;
		}

		if (path.startsWith("/api/events")) {
			const response = await eventRoutes(request, context);
			headers.forEach((value, key) => {
				response.headers.set(key, value);
			});
			return response;
		}

		if (path.startsWith("/webhooks/")) {
			const response = await controlPlaneProxy.handleWebhook(path, request);
			if (response) {
				headers.forEach((value, key) => {
					response.headers.set(key, value);
				});
				return response;
			}
		}

		const filePath = resolve(PUBLIC_DIR, `.${path === "/" ? "/index.html" : path}`);
		if (!filePath.startsWith(PUBLIC_DIR)) {
			return new Response("Forbidden", { status: 403, headers });
		}

		const file = Bun.file(filePath);
		if (await file.exists()) {
			const ext = extname(filePath);
			const mime = MIME_TYPES[ext] ?? "application/octet-stream";
			headers.set("Content-Type", mime);
			return new Response(await file.arrayBuffer(), { status: 200, headers });
		}

		const indexPath = join(PUBLIC_DIR, "index.html");
		const indexFile = Bun.file(indexPath);
		if (await indexFile.exists()) {
			headers.set("Content-Type", "text/html; charset=utf-8");
			return new Response(await indexFile.arrayBuffer(), { status: 200, headers });
		}

		return new Response("Not Found", { status: 404, headers });
	};

	const server = {
		port: options.port || 3000,
		fetch: handleRequest,
		hostname: "0.0.0.0",
		controlPlane: controlPlaneProxy,
	};

	return server;
}

export type ServerWithControlPlane = {
	serverConfig: ReturnType<typeof createServer>;
	controlPlane: ControlPlaneHandle | null;
};

export async function createServerAsync(
	options: Omit<ServerOptions, "controlPlane"> = {},
): Promise<ServerWithControlPlane> {
	const repoRoot = options.repoRoot || process.cwd();
	const config = options.config ?? (await readMuConfigFile(repoRoot));
	const controlPlane = await bootstrapControlPlane({ repoRoot, config: config.control_plane });
	const serverConfig = createServer({ ...options, controlPlane, config });
	return {
		serverConfig,
		controlPlane: serverConfig.controlPlane,
	};
}
