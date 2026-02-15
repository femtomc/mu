import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

function invariant(cond: unknown, msg: string): asserts cond {
	if (!cond) {
		throw new Error(msg);
	}
}

function contentTypeForPath(path: string): string {
	if (path.endsWith(".html")) return "text/html; charset=utf-8";
	if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
	if (path.endsWith(".css")) return "text/css; charset=utf-8";
	if (path.endsWith(".json")) return "application/json; charset=utf-8";
	if (path.endsWith(".svg")) return "image/svg+xml";
	if (path.endsWith(".png")) return "image/png";
	if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
	if (path.endsWith(".ico")) return "image/x-icon";
	return "application/octet-stream";
}

async function serveDist(): Promise<{ url: string; stop: () => void }> {
	const distDir = fileURLToPath(new URL("../dist", import.meta.url));
	invariant(existsSync(join(distDir, "index.html")), "packages/web/dist missing; run `bun run web:build` first");

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			const u = new URL(req.url);
			let pathname = u.pathname;
			if (pathname === "/") {
				pathname = "/index.html";
			}

			const fullPath = normalize(join(distDir, pathname));
			if (!fullPath.startsWith(distDir)) {
				return new Response("bad path", { status: 400 });
			}

			if (!existsSync(fullPath)) {
				return new Response("not found", { status: 404 });
			}

			const file = Bun.file(fullPath);
			return new Response(file, {
				headers: {
					"content-type": contentTypeForPath(fullPath),
					"cache-control": "no-store",
				},
			});
		},
	});

	return { url: server.url.toString(), stop: () => server.stop() };
}

async function waitForText(
	locator: { textContent(): Promise<string | null> },
	expected: string,
	opts: { timeoutMs?: number } = {},
): Promise<void> {
	const timeoutMs = opts.timeoutMs ?? 5000;
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const text = (await locator.textContent()) ?? "";
		if (text.trim() === expected) {
			return;
		}
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`timeout waiting for text=${JSON.stringify(expected)}`);
}

async function main(): Promise<void> {
	const server = await serveDist();
	try {
		const browser = await chromium.launch({ headless: true });
		try {
			const page = await browser.newPage();

			// Hard guard: the demo must not make any external network calls.
			await page.route("**/*", async (route) => {
				const url = route.request().url();
				const u = new URL(url);
				const isLocalHost =
					(u.protocol === "http:" || u.protocol === "https:" || u.protocol === "ws:" || u.protocol === "wss:") &&
					(u.hostname === "127.0.0.1" || u.hostname === "localhost");
				const isLocalScheme = u.protocol === "data:" || u.protocol === "blob:" || u.protocol === "about:";
				if (isLocalHost || isLocalScheme) {
					await route.continue();
				} else {
					await route.abort();
				}
			});

			await page.goto(server.url, { waitUntil: "domcontentloaded" });

			// Reset persisted state so this test is deterministic.
			await page.getByTestId("reset").click();

			await waitForText(page.getByTestId("issues-count"), "0");
			await waitForText(page.getByTestId("topics-count"), "0");
			await waitForText(page.getByTestId("events-count"), "0");

			// Create an issue and confirm ready leaves list updates.
			await page.getByTestId("issue-title").fill("hello from playwright");
			await page.getByTestId("create-issue").click();

			await waitForText(page.getByTestId("issues-count"), "1");
			await waitForText(page.getByTestId("ready-count"), "1");

			// Post a forum message, then read it, then list topics.
			await page.getByTestId("forum-topic").fill("issue:demo");
			await page.getByTestId("forum-author").fill("worker");
			await page.getByTestId("forum-body").fill("persist me");
			await page.getByTestId("forum-post").click();

			await waitForText(page.getByTestId("topics-count"), "1");
			const messagesJson1 = await page.getByTestId("messages-json").textContent();
			invariant(messagesJson1?.includes("persist me"), "expected posted message to appear in messages-json");

			const events1 = Number.parseInt(((await page.getByTestId("events-count").textContent()) ?? "0").trim(), 10);
			invariant(Number.isFinite(events1) && events1 >= 2, `expected events-count >= 2, got ${events1}`);

			// Reload and confirm persistence across page reload.
			await page.reload({ waitUntil: "domcontentloaded" });

			await waitForText(page.getByTestId("issues-count"), "1");
			await waitForText(page.getByTestId("ready-count"), "1");
			await waitForText(page.getByTestId("topics-count"), "1");

			const messagesJson2 = await page.getByTestId("messages-json").textContent();
			invariant(messagesJson2?.includes("persist me"), "expected message to persist across reload");

			const errText = ((await page.getByTestId("errors").textContent()) ?? "").trim();
			invariant(errText.length === 0, `unexpected error output: ${errText}`);
		} finally {
			await browser.close();
		}
	} finally {
		server.stop();
	}
}

try {
	await main();
} catch (err) {
	console.error(err);
	process.exitCode = 1;
}

