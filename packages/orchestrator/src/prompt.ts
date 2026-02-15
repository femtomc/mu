import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { Issue } from "@mu/core";

export type PromptMeta = Record<string, unknown>;

function stripQuotes(s: string): string {
	const trimmed = s.trim();
	if (trimmed.length >= 2) {
		const first = trimmed[0];
		const last = trimmed[trimmed.length - 1];
		if ((first === `"` && last === `"`) || (first === `'` && last === `'`)) {
			return trimmed.slice(1, -1);
		}
	}
	return trimmed;
}

function parseSimpleYamlFrontmatter(text: string): PromptMeta {
	// We only need a small subset: flat `key: value` mappings.
	// If parsing fails, we return {} (mirrors Python behavior).
	const out: PromptMeta = {};
	const lines = text.split(/\r?\n/);
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (line.length === 0) {
			continue;
		}
		if (line.startsWith("#")) {
			continue;
		}
		const idx = line.indexOf(":");
		if (idx <= 0) {
			continue;
		}
		const key = line.slice(0, idx).trim();
		if (!key) {
			continue;
		}
		const value = stripQuotes(line.slice(idx + 1));
		out[key] = value;
	}
	return out;
}

export function splitFrontmatter(text: string): { meta: PromptMeta; body: string } {
	const lines = text.split(/\r?\n/);
	if (lines.length === 0 || lines[0]?.trim() !== "---") {
		return { meta: {}, body: text };
	}

	// Find the terminating `---` line.
	let endIdx = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i]?.trim() === "---") {
			endIdx = i;
			break;
		}
	}
	if (endIdx < 0) {
		return { meta: {}, body: text };
	}

	try {
		const metaText = lines.slice(1, endIdx).join("\n");
		const body = lines
			.slice(endIdx + 1)
			.join("\n")
			.replace(/^\n+/, "");
		const meta = parseSimpleYamlFrontmatter(metaText);
		return { meta, body };
	} catch {
		return { meta: {}, body: text };
	}
}

function firstNonEmptyLine(text: string): string {
	for (const line of text.split(/\r?\n/)) {
		const stripped = line.trim();
		if (stripped) {
			return stripped;
		}
	}
	return "";
}

export function extractDescription(meta: PromptMeta, body: string): { description: string; source: string } {
	const raw = meta.description;
	const desc = typeof raw === "string" ? raw.trim() : "";
	if (desc) {
		return { description: desc, source: "frontmatter" };
	}
	const bodyDesc = firstNonEmptyLine(body);
	if (bodyDesc) {
		return { description: bodyDesc, source: "body" };
	}
	return { description: "", source: "none" };
}

export async function readPromptMeta(path: string): Promise<PromptMeta> {
	const text = await readFile(path, "utf8");
	const { meta } = splitFrontmatter(text);
	return meta;
}

function toPosixPath(path: string): string {
	return path.replaceAll("\\", "/");
}

export async function buildRoleCatalog(repoRoot: string): Promise<string> {
	const rolesDir = join(repoRoot, ".inshallah", "roles");
	let entries: string[];
	try {
		entries = await readdir(rolesDir);
	} catch {
		return "";
	}

	const roleFiles = entries.filter((e) => e.endsWith(".md")).sort();
	const sections: string[] = [];

	for (const file of roleFiles) {
		const abs = join(rolesDir, file);
		const text = await readFile(abs, "utf8");
		const { meta, body } = splitFrontmatter(text);

		const name = file.replace(/\.md$/, "");
		const promptPath = toPosixPath(relative(repoRoot, abs));
		const { description, source } = extractDescription(meta, body);

		const parts: string[] = [];
		for (const key of ["cli", "model", "reasoning"] as const) {
			if (key in meta) {
				parts.push(`${key}: ${String(meta[key])}`);
			}
		}
		const configLine = parts.length > 0 ? parts.join(" | ") : "default config";
		const catalogDesc = description || "No description provided.";

		sections.push(
			`### ${name}\n` +
				`description: ${catalogDesc}\n` +
				`description_source: ${source}\n` +
				`prompt: ${promptPath}\n` +
				`config: ${configLine}`,
		);
	}

	return sections.join("\n\n");
}

export async function renderPromptTemplate(
	path: string,
	issue: Pick<Issue, "id" | "title" | "body">,
	opts: { repoRoot?: string } = {},
): Promise<string> {
	const text = await readFile(path, "utf8");
	const { body } = splitFrontmatter(text);

	let promptText = issue.title ?? "";
	if (issue.body) {
		promptText += `\n\n${issue.body}`;
	}

	let rendered = body;
	rendered = rendered.replaceAll("{{PROMPT}}", promptText);
	rendered = rendered.replaceAll("{{ISSUE_ID}}", issue.id ?? "");

	if (rendered.includes("{{ROLES}}")) {
		const catalog = opts.repoRoot ? await buildRoleCatalog(opts.repoRoot) : "";
		rendered = rendered.replaceAll("{{ROLES}}", catalog);
	}

	return rendered;
}

export function resolvePromptPath(repoRoot: string, promptPath: string): string {
	if (isAbsolute(promptPath)) {
		return promptPath;
	}
	return join(repoRoot, promptPath);
}
