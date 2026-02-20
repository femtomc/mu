import chalk from "chalk";

export type CliPrimitiveRunResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

function hasAnsiSequences(text: string): boolean {
	return /\x1b\[[0-9;]*m/.test(text);
}

function styleHelpLine(line: string, index: number): string {
	if (line.length === 0) {
		return line;
	}
	const match = line.match(/^(\s*)(.*)$/);
	const indent = match?.[1] ?? "";
	const body = match?.[2] ?? line;
	const trimmed = body.trim();
	if (trimmed.length === 0) {
		return line;
	}

	if (index === 0 && trimmed.startsWith("mu ")) {
		const header = trimmed.match(/^mu\s+([\w-]+)(\s+-\s+.*)?$/);
		if (header) {
			const subcommand = header[1] ?? "";
			const summary = header[2] ?? "";
			return `${indent}${chalk.bold.magenta("mu")} ${chalk.cyan(subcommand)}${chalk.dim(summary)}`;
		}
	}

	if (/^[A-Za-z][A-Za-z0-9 /_-]*:$/.test(trimmed)) {
		return `${indent}${chalk.bold(trimmed)}`;
	}

	const usageLine = body.match(/^mu\s+([\w-]+)(.*)$/);
	if (usageLine) {
		const subcommand = usageLine[1] ?? "";
		const rest = usageLine[2] ?? "";
		return `${indent}${chalk.bold.magenta("mu")} ${chalk.cyan(subcommand)}${chalk.dim(rest)}`;
	}

	const optionLine = body.match(/^(--[\w-]+)(\s+.*)?$/);
	if (optionLine) {
		const flag = optionLine[1] ?? "";
		const rest = optionLine[2] ?? "";
		return `${indent}${chalk.cyan(flag)}${chalk.dim(rest)}`;
	}

	return `${indent}${body.replace(/`(mu [^`]+)`/g, (_m, cmdText) => `\`${chalk.cyan(cmdText)}\``)}`;
}

function styleHelpTextIfNeeded(stdout: string): string {
	if (!process.stdout.isTTY) {
		return stdout;
	}
	if (hasAnsiSequences(stdout)) {
		return stdout;
	}
	if (!stdout.includes("\nUsage:\n") && !stdout.startsWith("mu ")) {
		return stdout;
	}
	const lines = stdout.split("\n");
	return lines.map((line, index) => styleHelpLine(line, index)).join("\n");
}

export function ok(stdout: string = "", exitCode: number = 0): CliPrimitiveRunResult {
	return { stdout: styleHelpTextIfNeeded(stdout), stderr: "", exitCode };
}

export function jsonText(data: unknown, pretty: boolean): string {
	return `${JSON.stringify(data, null, pretty ? 2 : 0)}\n`;
}

export function formatRecovery(recovery?: readonly string[] | null): string {
	if (!recovery || recovery.length === 0) {
		return "";
	}
	return `\n${chalk.dim("Try:")} ${recovery.map((r) => chalk.cyan(r)).join(chalk.dim(" | "))}`;
}

export function jsonError(
	msg: string,
	opts: { pretty?: boolean; recovery?: readonly string[] } = {},
): CliPrimitiveRunResult {
	const pretty = opts.pretty ?? false;
	if (pretty || !process.stdout.isTTY) {
		return { stdout: jsonText({ error: `${msg}` }, pretty), stderr: "", exitCode: 1 };
	}
	return { stdout: "", stderr: `${chalk.red("error:")} ${msg}${formatRecovery(opts.recovery)}\n`, exitCode: 1 };
}

export function hasHelpFlag(argv: readonly string[]): boolean {
	return argv.includes("--help") || argv.includes("-h");
}

export function popFlag(argv: readonly string[], name: string): { present: boolean; rest: string[] } {
	let present = false;
	const rest: string[] = [];
	for (const a of argv) {
		if (a === name) {
			present = true;
			continue;
		}
		rest.push(a);
	}
	return { present, rest };
}

export function getFlagValue(argv: readonly string[], name: string): { value: string | null; rest: string[] } {
	const rest: string[] = [];
	let value: string | null = null;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === name) {
			const next = argv[i + 1];
			if (next == null) {
				value = "";
				i += 0;
				continue;
			}
			value = next;
			i += 1;
			continue;
		}
		if (a.startsWith(`${name}=`)) {
			value = a.slice(`${name}=`.length);
			continue;
		}
		rest.push(a);
	}
	return { value, rest };
}

export function getRepeatFlagValues(argv: readonly string[], names: readonly string[]): { values: string[]; rest: string[] } {
	const nameSet = new Set(names);
	const values: string[] = [];
	const rest: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (nameSet.has(a)) {
			const next = argv[i + 1];
			if (next != null) {
				values.push(next);
				i += 1;
			}
			continue;
		}
		let matched = false;
		for (const name of names) {
			if (a.startsWith(`${name}=`)) {
				values.push(a.slice(`${name}=`.length));
				matched = true;
				break;
			}
		}
		if (matched) {
			continue;
		}
		rest.push(a);
	}
	return { values, rest };
}

export function ensureInt(value: string, opts: { name: string; min?: number; max?: number }): number | null {
	const n = Number.parseInt(value, 10);
	if (!Number.isFinite(n)) {
		return null;
	}
	if (opts.min != null && n < opts.min) {
		return null;
	}
	if (opts.max != null && n > opts.max) {
		return null;
	}
	return n;
}
