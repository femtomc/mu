import { describe, expect, test } from "bun:test";
import { parseSeriousWorkCommand } from "@femtomc/mu-control-plane";

describe("parseSeriousWorkCommand", () => {
	test("accepts strict serious-work grammar", () => {
		const slash = parseSeriousWorkCommand("/mu issue close mu-123");
		expect(slash).toMatchObject({
			kind: "command",
			invocation: "slash",
			requestedMode: "auto",
			commandKey: "issue close",
			args: ["mu-123"],
		});

		const mutate = parseSeriousWorkCommand("mu! forum post hello world");
		expect(mutate).toMatchObject({
			kind: "command",
			invocation: "mu_bang",
			requestedMode: "mutation",
			commandKey: "forum post",
			args: ["hello", "world"],
		});

		const readonly = parseSeriousWorkCommand("mu? status");
		expect(readonly).toMatchObject({
			kind: "command",
			invocation: "mu_question",
			requestedMode: "readonly",
			commandKey: "status",
			args: [],
		});

		const runResume = parseSeriousWorkCommand("/mu run resume mu-abc123 40");
		expect(runResume).toMatchObject({
			kind: "command",
			invocation: "slash",
			requestedMode: "auto",
			commandKey: "run resume",
			args: ["mu-abc123", "40"],
		});

		const runList = parseSeriousWorkCommand("/mu run list");
		expect(runList).toMatchObject({
			kind: "command",
			invocation: "slash",
			requestedMode: "auto",
			commandKey: "run list",
			args: [],
		});

		const runStatus = parseSeriousWorkCommand("/mu run status mu-abc123");
		expect(runStatus).toMatchObject({
			kind: "command",
			invocation: "slash",
			requestedMode: "auto",
			commandKey: "run status",
			args: ["mu-abc123"],
		});

		const runInterrupt = parseSeriousWorkCommand("/mu run interrupt mu-abc123");
		expect(runInterrupt).toMatchObject({
			kind: "command",
			invocation: "slash",
			requestedMode: "auto",
			commandKey: "run interrupt",
			args: ["mu-abc123"],
		});

		const reload = parseSeriousWorkCommand("/reload");
		expect(reload).toMatchObject({
			kind: "command",
			invocation: "slash",
			requestedMode: "auto",
			commandKey: "reload",
			args: [],
		});

		const update = parseSeriousWorkCommand("/update");
		expect(update).toMatchObject({
			kind: "command",
			invocation: "slash",
			requestedMode: "auto",
			commandKey: "update",
			args: [],
		});

		const operatorModelSet = parseSeriousWorkCommand("/mu operator model set openai-codex gpt-5.3-codex xhigh");
		expect(operatorModelSet).toMatchObject({
			kind: "command",
			invocation: "slash",
			requestedMode: "auto",
			commandKey: "operator model set",
			args: ["openai-codex", "gpt-5.3-codex", "xhigh"],
		});
	});

	test("parses confirm/cancel commands", () => {
		const confirm = parseSeriousWorkCommand("mu! confirm cmd-42");
		expect(confirm).toEqual({
			kind: "confirm",
			invocation: "mu_bang",
			requestedMode: "mutation",
			commandId: "cmd-42",
			normalized: "confirm cmd-42",
		});

		const cancel = parseSeriousWorkCommand("/mu cancel cmd-42");
		expect(cancel).toEqual({
			kind: "cancel",
			invocation: "slash",
			requestedMode: "auto",
			commandId: "cmd-42",
			normalized: "cancel cmd-42",
		});
	});

	test("treats casual/non-command text as explicit no-op", () => {
		expect(parseSeriousWorkCommand("hey can you close this issue?")).toEqual({
			kind: "noop",
			reason: "not_command",
			raw: "hey can you close this issue?",
		});
		expect(parseSeriousWorkCommand("mu issue close mu-123")).toEqual({
			kind: "noop",
			reason: "not_command",
			raw: "mu issue close mu-123",
		});
	});
});
