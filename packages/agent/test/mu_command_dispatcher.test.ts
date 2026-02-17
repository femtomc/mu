import { afterEach, describe, expect, test } from "bun:test";
import { brandingExtension } from "../src/extensions/branding.js";
import { eventLogExtension } from "../src/extensions/event-log.js";
import { registerMuSubcommand, resetMuCommandDispatcher } from "../src/extensions/mu-command-dispatcher.js";
import { messagingSetupExtension } from "../src/extensions/messaging-setup.js";
import { serverToolsExtension } from "../src/extensions/server-tools.js";

type RegisteredCommand = {
	description: string;
	handler: (args: string, ctx: any) => Promise<void>;
};

function createPiMock() {
	const commands = new Map<string, RegisteredCommand>();
	const api = {
		registerCommand(name: string, command: RegisteredCommand) {
			commands.set(name, command);
		},
		registerTool() {
			return undefined;
		},
		on() {
			return undefined;
		},
		sendUserMessage() {
			return undefined;
		},
	};
	return { api, commands };
}

function createCommandContext() {
	const notifications: Array<{ text: string; level: string }> = [];
	return {
		notifications,
		ctx: {
			hasUI: true,
			isIdle: () => true,
			ui: {
				notify(text: string, level: string) {
					notifications.push({ text, level });
				},
			},
		},
	};
}

describe("mu command dispatcher", () => {
	afterEach(() => {
		resetMuCommandDispatcher();
	});

	test("registerMuSubcommand installs one /mu command and dispatches by subcommand", async () => {
		const pi = createPiMock();
		const calls: Array<{ subcommand: string; args: string }> = [];

		registerMuSubcommand(pi.api as any, {
			subcommand: "status",
			summary: "Show status",
			usage: "/mu status",
			handler: async (args) => {
				calls.push({ subcommand: "status", args });
			},
		});
		registerMuSubcommand(pi.api as any, {
			subcommand: "events",
			summary: "Inspect event log",
			usage: "/mu events [n]",
			aliases: ["ev"],
			handler: async (args) => {
				calls.push({ subcommand: "events", args });
			},
		});

		expect([...pi.commands.keys()]).toEqual(["mu"]);
		const command = pi.commands.get("mu");
		if (!command) {
			throw new Error("missing /mu dispatcher");
		}

		const { ctx, notifications } = createCommandContext();

		await command.handler("status", ctx);
		await command.handler("ev tail 5", ctx);
		expect(calls).toEqual([
			{ subcommand: "status", args: "" },
			{ subcommand: "events", args: "tail 5" },
		]);

		await command.handler("help events", ctx);
		expect(notifications.at(-1)?.text).toContain("Usage: /mu events [n]");

		await command.handler("", ctx);
		const catalog = notifications.at(-1)?.text ?? "";
		expect(catalog).toContain("/mu status");
		expect(catalog).toContain("/mu events [n]");

		await command.handler("unknown", ctx);
		expect(notifications.at(-1)?.level).toBe("error");
		expect(notifications.at(-1)?.text).toContain("Unknown mu subcommand: unknown");
	});

	test("serve extensions expose only /mu command entrypoint", async () => {
		const pi = createPiMock();

		serverToolsExtension(pi.api as any);
		eventLogExtension(pi.api as any);
		messagingSetupExtension(pi.api as any);
		brandingExtension(pi.api as any);

		expect([...pi.commands.keys()]).toEqual(["mu"]);
		expect(pi.commands.has("mu-status")).toBe(false);
		expect(pi.commands.has("mu-control")).toBe(false);
		expect(pi.commands.has("mu-setup")).toBe(false);
		expect(pi.commands.has("mu-events")).toBe(false);
		expect(pi.commands.has("mu-brand")).toBe(false);

		const command = pi.commands.get("mu");
		if (!command) {
			throw new Error("missing /mu dispatcher");
		}

		const { ctx, notifications } = createCommandContext();
		await command.handler("help", ctx);
		const helpText = notifications.at(-1)?.text ?? "";
		expect(helpText).toContain("/mu status");
		expect(helpText).toContain("/mu control");
		expect(helpText).toContain("/mu setup");
		expect(helpText).toContain("/mu events");
		expect(helpText).toContain("/mu brand");
	});
});
