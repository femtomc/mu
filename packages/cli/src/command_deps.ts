import type { IssueStore } from "@femtomc/mu-issue";
import {
	ensureInt,
	getFlagValue,
	getRepeatFlagValues,
	hasHelpFlag,
	jsonError,
	jsonText,
	ok,
	popFlag,
} from "./cli_primitives.js";
import {
	delayMs,
	describeError,
	ensureTrailingNewline,
	setSearchParamIfPresent,
	trimForHeader,
} from "./cli_utils.js";
import {
	issueJson,
	renderCronPayloadCompact,
	renderEventsCompactTable,
	renderForumPostCompact,
	renderForumReadCompact,
	renderForumTopicsCompact,
	renderHeartbeatsPayloadCompact,
	renderIssueCompactTable,
	renderIssueDepMutationCompact,
	renderIssueDetailCompact,
	renderIssueMutationCompact,
	renderRunPayloadCompact,
} from "./render.js";
import { cleanupStaleServerFiles, detectRunningServer, readApiError } from "./server_helpers.js";
import {
	defaultOperatorSessionStart,
	ensureStoreInitialized,
	fileExists,
	nonEmptyString,
	storePathForRepoRoot,
} from "./workspace_runtime.js";

type ResolveIssueIdFn = (
	store: IssueStore,
	rawId: string,
) => Promise<{ issueId: string | null; error: string | null }>;

type RequestServerJsonFn<Ctx, Result> = <T>(opts: {
	ctx: Ctx;
	pretty: boolean;
	method?: "GET" | "POST";
	path: string;
	body?: Record<string, unknown>;
	recoveryCommand: string;
}) => Promise<{ ok: true; payload: T } | { ok: false; result: Result }>;

export function statusCommandDeps() {
	return {
		hasHelpFlag,
		popFlag,
		jsonError,
		jsonText,
		ok,
	};
}

export function storeCommandDeps() {
	return {
		hasHelpFlag,
		popFlag,
		getFlagValue,
		ensureInt,
		jsonError,
		jsonText,
		ok,
		fileExists,
	};
}

export function issuesCommandDeps(resolveIssueId: ResolveIssueIdFn) {
	return {
		hasHelpFlag,
		popFlag,
		getFlagValue,
		getRepeatFlagValues,
		ensureInt,
		jsonError,
		jsonText,
		ok,
		resolveIssueId,
		issueJson,
		renderIssueCompactTable,
		renderIssueDetailCompact,
		renderIssueMutationCompact,
		renderIssueDepMutationCompact,
	};
}

export function forumCommandDeps() {
	return {
		hasHelpFlag,
		popFlag,
		getFlagValue,
		ensureInt,
		jsonError,
		jsonText,
		ok,
		renderForumPostCompact,
		renderForumReadCompact,
		renderForumTopicsCompact,
	};
}

export function eventsCommandDeps() {
	return {
		hasHelpFlag,
		popFlag,
		getFlagValue,
		ensureInt,
		jsonError,
		jsonText,
		ok,
		renderEventsCompactTable,
	};
}

export function schedulingCommandDeps<Ctx, Result>(requestServerJson: RequestServerJsonFn<Ctx, Result>) {
	return {
		hasHelpFlag,
		popFlag,
		getFlagValue,
		ensureInt,
		setSearchParamIfPresent,
		jsonError,
		jsonText,
		ok,
		requestServerJson,
		renderRunPayloadCompact,
		renderHeartbeatsPayloadCompact,
		renderCronPayloadCompact,
	};
}

export function memoryCommandDeps() {
	return {
		hasHelpFlag,
		popFlag,
		getFlagValue,
		ensureInt,
		setSearchParamIfPresent,
		jsonError,
		jsonText,
		ok,
		describeError,
	};
}

export function turnCommandDeps() {
	return {
		hasHelpFlag,
		popFlag,
		getFlagValue,
		jsonError,
		ok,
		jsonText,
		describeError,
	};
}

export function runCommandDeps<Ctx, Result>(runServeLifecycle: (ctx: Ctx, opts: any) => Promise<Result>) {
	return {
		hasHelpFlag,
		ensureInt,
		jsonError,
		ok,
		runServeLifecycle,
	};
}

export function runDirectCommandDeps() {
	return {
		hasHelpFlag,
		ensureInt,
		jsonError,
		jsonText,
		ok,
		ensureStoreInitialized,
		trimForHeader,
		ensureTrailingNewline,
	};
}

export function resumeCommandDeps(resolveIssueId: ResolveIssueIdFn) {
	return {
		hasHelpFlag,
		ensureInt,
		jsonError,
		jsonText,
		ok,
		ensureStoreInitialized,
		resolveIssueId,
		trimForHeader,
		ensureTrailingNewline,
	};
}

export function replayCommandDeps() {
	return {
		hasHelpFlag,
		getFlagValue,
		jsonError,
		ok,
		fileExists,
	};
}

export function sessionCommandDeps<Ctx, Result>(runServeLifecycle: (ctx: Ctx, opts: any) => Promise<Result>) {
	return {
		hasHelpFlag,
		getFlagValue,
		popFlag,
		ensureInt,
		jsonError,
		jsonText,
		ok,
		fileExists,
		trimForHeader,
		runServeLifecycle,
	};
}

export function operatorSessionCommandDeps() {
	return {
		hasHelpFlag,
		popFlag,
		getFlagValue,
		jsonError,
		jsonText,
		ok,
		defaultOperatorSessionStart,
	};
}

export function loginCommandDeps() {
	return {
		hasHelpFlag,
		popFlag,
		jsonError,
		ok,
	};
}

export function serveCommandDeps<Ctx, ServeDeps, Result>(opts: {
	buildServeDeps: (ctx: Ctx) => ServeDeps;
	runServeLifecycle: (ctx: Ctx, opts: any) => Promise<Result>;
}) {
	return {
		hasHelpFlag,
		getFlagValue,
		popFlag,
		ensureInt,
		jsonError,
		ok,
		delayMs,
		detectRunningServer,
		buildServeDeps: opts.buildServeDeps,
		cleanupStaleServerFiles,
		runServeLifecycle: opts.runServeLifecycle,
	};
}

export function controlCommandDeps() {
	return {
		hasHelpFlag,
		popFlag,
		getFlagValue,
		getRepeatFlagValues,
		ensureInt,
		jsonError,
		jsonText,
		ok,
		fileExists,
		nonEmptyString,
		describeError,
		storePathForRepoRoot,
		detectRunningServer,
		readApiError,
	};
}
