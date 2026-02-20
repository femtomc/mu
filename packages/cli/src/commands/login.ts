import { createInterface } from "node:readline";

export type LoginCommandRunResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

export type LoginCommandDeps = {
	hasHelpFlag: (argv: readonly string[]) => boolean;
	popFlag: (argv: readonly string[], name: string) => { present: boolean; rest: string[] };
	jsonError: (msg: string, opts?: { pretty?: boolean; recovery?: readonly string[] }) => LoginCommandRunResult;
	ok: (stdout?: string, exitCode?: number) => LoginCommandRunResult;
};

function readLine(prompt: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	return new Promise<string>((resolve) => {
		rl.question(prompt, (answer) => {
			rl.close();
			resolve(answer);
		});
	});
}

export async function cmdLogin(argv: string[], deps: LoginCommandDeps): Promise<LoginCommandRunResult> {
	const { hasHelpFlag, popFlag, jsonError, ok } = deps;
	if (hasHelpFlag(argv)) {
		return ok(
			[
				"mu login - authenticate with an AI provider via OAuth",
				"",
				"Usage:",
				"  mu login [<provider>] [--list] [--logout]",
				"",
				"Examples:",
				"  mu login --list                 List available OAuth providers",
				"  mu login openai-codex           Login to OpenAI (ChatGPT Plus)",
				"  mu login anthropic              Login to Anthropic (Claude Pro/Max)",
				"  mu login github-copilot         Login to GitHub Copilot",
				"  mu login google-gemini-cli      Login to Google Gemini CLI",
				"  mu login openai-codex --logout  Remove stored credentials",
				"",
				"Credentials are stored in ~/.pi/agent/auth.json (shared with pi CLI).",
				"",
				"See also: `mu guide`",
			].join("\n") + "\n",
		);
	}

	const { AuthStorage } = await import("@mariozechner/pi-coding-agent");
	const { getOAuthProviders } = await import("@mariozechner/pi-ai");

	const authStorage = AuthStorage.create();
	const providers = getOAuthProviders();

	const { present: listMode, rest: argv0 } = popFlag(argv, "--list");
	const { present: logoutMode, rest: argv1 } = popFlag(argv0, "--logout");

	if (listMode || argv1.length === 0) {
		const lines: string[] = ["Available OAuth providers:", ""];
		for (const p of providers) {
			const hasAuth = authStorage.hasAuth(p.id);
			const status = hasAuth ? "[authenticated]" : "[not configured]";
			lines.push(`  ${p.id.padEnd(24)} ${p.name.padEnd(30)} ${status}`);
		}
		lines.push("", "Environment variable auth (no login needed):");
		lines.push("  Set OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY, etc.");
		return ok(`${lines.join("\n")}\n`);
	}

	const providerId = argv1[0]!;
	const rest = argv1.slice(1);
	if (rest.length > 0) {
		return jsonError(`unknown args: ${rest.join(" ")}`, { recovery: ["mu login --help"] });
	}

	const provider = providers.find((p) => p.id === providerId);
	if (!provider) {
		const available = providers.map((p) => p.id).join(", ");
		return jsonError(`unknown provider: ${providerId}`, {
			recovery: [`mu login --list`, `Available: ${available}`],
		});
	}

	if (logoutMode) {
		authStorage.logout(providerId);
		return ok(`Logged out from ${provider.name} (${providerId})\n`);
	}

	try {
		await authStorage.login(providerId, {
			onAuth: (info: { url: string; instructions?: string }) => {
				process.stderr.write(`\nOpen this URL to authenticate:\n  ${info.url}\n\n`);
				if (info.instructions) {
					process.stderr.write(`${info.instructions}\n\n`);
				}
				try {
					if (process.platform === "darwin") {
						Bun.spawn(["open", info.url], { stdout: "ignore", stderr: "ignore" });
					} else if (process.platform === "linux") {
						Bun.spawn(["xdg-open", info.url], { stdout: "ignore", stderr: "ignore" });
					}
				} catch {
					// best-effort auto-open
				}
			},
			onPrompt: async (prompt: { message: string; placeholder?: string }) => {
				const msg = prompt.placeholder ? `${prompt.message} [${prompt.placeholder}]: ` : `${prompt.message}: `;
				const answer = await readLine(msg);
				if (!answer && prompt.placeholder) return prompt.placeholder;
				return answer;
			},
			onProgress: (message: string) => {
				process.stderr.write(`${message}\n`);
			},
			onManualCodeInput: async () => {
				return await readLine("Paste the authorization code or callback URL: ");
			},
		});
	} catch (err) {
		return jsonError(`login failed: ${err instanceof Error ? err.message : String(err)}`, {
			recovery: [`mu login ${providerId}`],
		});
	}

	return ok(`Authenticated with ${provider.name} (${providerId})\n`);
}
