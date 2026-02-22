import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { brandingExtension } from "../src/extensions/branding.js";
import { resetHudMode, setActiveHudMode } from "../src/extensions/hud-mode.js";
import { resetMuCommandDispatcher } from "../src/extensions/mu-command-dispatcher.js";

type EventHandler = (event: unknown, ctx: unknown) => Promise<void> | void;
type FooterFactory = (tui: unknown, theme: unknown, footerData: unknown) => {
	dispose: () => void;
	invalidate: () => void;
	render: (width: number) => string[];
};

function createExtensionApiMock() {
	const handlers = new Map<string, EventHandler>();
	const api = {
		registerTool() {
			return undefined;
		},
		registerCommand() {
			return undefined;
		},
		on(event: string, handler: EventHandler) {
			handlers.set(event, handler);
			return undefined;
		},
	};
	return { api, handlers };
}

function createUiContext() {
	let footerFactory: FooterFactory | undefined;
	const extensionStatuses = new Map<string, string>();
	const theme = {
		fg: (_tone: string, text: string) => text,
		bold: (text: string) => text,
	};
	const ctx = {
		hasUI: true,
		cwd: process.cwd(),
		model: { id: "gpt-5.3-codex" },
		getContextUsage: () => ({ percent: 3 }),
		ui: {
			setTheme: () => ({ success: true }),
			setTitle: () => undefined,
			setWorkingMessage: () => undefined,
			setWidget: () => undefined,
			setHeader: () => undefined,
			setFooter: (factory: FooterFactory | undefined) => {
				footerFactory = factory;
			},
			setStatus: () => undefined,
			notify: () => undefined,
			theme,
		},
	};
	return {
		ctx,
		theme,
		getFooterFactory: () => footerFactory,
		extensionStatuses,
	};
}

function renderFooterLine(opts: { footerFactory: FooterFactory; theme: { fg: (tone: string, text: string) => string } | { fg: (tone: string, text: string) => string; bold: (text: string) => string }; extensionStatuses: Map<string, string> }) {
	const footer = opts.footerFactory(
		{ requestRender: () => undefined },
		opts.theme,
		{
			onBranchChange: () => () => undefined,
			getGitBranch: () => "main",
			getExtensionStatuses: () => opts.extensionStatuses,
		},
	);
	const line = footer.render(200)[0] ?? "";
	footer.dispose();
	return line;
}

describe("branding footer HUD integration", () => {
	beforeEach(() => {
		resetMuCommandDispatcher();
		resetHudMode();
	});

	afterEach(() => {
		resetMuCommandDispatcher();
		resetHudMode();
	});

	test("does not render planning HUD markers in branding footer", async () => {
		const { api, handlers } = createExtensionApiMock();
		brandingExtension(api as unknown as Parameters<typeof brandingExtension>[0]);

		const uiHarness = createUiContext();
		const sessionStart = handlers.get("session_start");
		if (!sessionStart) {
			throw new Error("session_start handler missing");
		}

		await sessionStart({}, uiHarness.ctx);
		const footerFactory = uiHarness.getFooterFactory();
		if (!footerFactory) {
			throw new Error("footer factory missing");
		}

		setActiveHudMode("planning");
		uiHarness.extensionStatuses.set("mu-planning-meta", "phase:waiting-user steps:0/4 wait:yes conf:high");
		const rendered = renderFooterLine({
			footerFactory,
			theme: uiHarness.theme,
			extensionStatuses: uiHarness.extensionStatuses,
		});
		expect(rendered).not.toContain("hud:planning");
		expect(rendered).not.toContain("phase:waiting-user");

		const shutdown = handlers.get("session_shutdown");
		if (shutdown) {
			await shutdown({}, uiHarness.ctx);
		}
	});

	test("does not render subagents HUD markers in branding footer", async () => {
		const { api, handlers } = createExtensionApiMock();
		brandingExtension(api as unknown as Parameters<typeof brandingExtension>[0]);

		const uiHarness = createUiContext();
		const sessionStart = handlers.get("session_start");
		if (!sessionStart) {
			throw new Error("session_start handler missing");
		}

		await sessionStart({}, uiHarness.ctx);
		const footerFactory = uiHarness.getFooterFactory();
		if (!footerFactory) {
			throw new Error("footer factory missing");
		}

		setActiveHudMode("subagents");
		uiHarness.extensionStatuses.set("mu-subagents-meta", "q:1/0 tmux:1");
		const rendered = renderFooterLine({
			footerFactory,
			theme: uiHarness.theme,
			extensionStatuses: uiHarness.extensionStatuses,
		});
		expect(rendered).not.toContain("hud:subagents");
		expect(rendered).not.toContain("q:1/0");

		const shutdown = handlers.get("session_shutdown");
		if (shutdown) {
			await shutdown({}, uiHarness.ctx);
		}
	});
});
