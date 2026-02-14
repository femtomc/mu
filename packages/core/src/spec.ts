import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

export type ExecutionSpec = {
	role: string | null;
	prompt_path: string | null;
	cli: string | null;
	model: string | null;
	reasoning: string | null;
};

function emptyStringToNull(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

export function executionSpecFromDict(d: Record<string, unknown>, repoRoot?: string): ExecutionSpec {
	let prompt_path = emptyStringToNull(d.prompt_path);
	const role = emptyStringToNull(d.role);

	// Auto-resolve prompt_path from role name
	if (!prompt_path && role && repoRoot) {
		const candidate = join(repoRoot, ".inshallah", "roles", `${role}.md`);
		if (existsSync(candidate)) {
			prompt_path = candidate;
		}
	}

	// Resolve relative prompt_path against repoRoot
	if (repoRoot && prompt_path && !isAbsolute(prompt_path)) {
		prompt_path = join(repoRoot, prompt_path);
	}

	return {
		role,
		prompt_path,
		cli: emptyStringToNull(d.cli),
		model: emptyStringToNull(d.model),
		reasoning: emptyStringToNull(d.reasoning),
	};
}

export const DepSchema = z
	.object({
		type: z.string().min(1),
		target: z.string().min(1),
	})
	.passthrough();
export type Dep = z.infer<typeof DepSchema>;

export const IssueSchema = z
	.object({
		id: z.string().min(1),
		title: z.string(),
		body: z.string(),
		status: z.enum(["open", "in_progress", "closed"]),
		outcome: z.string().nullable(),
		tags: z.array(z.string()),
		deps: z.array(DepSchema),
		execution_spec: z.record(z.string(), z.unknown()).nullable(),
		priority: z.number().int(),
		created_at: z.number().int(),
		updated_at: z.number().int(),
	})
	.passthrough();
export type Issue = z.infer<typeof IssueSchema>;

export const ForumMessageSchema = z
	.object({
		topic: z.string().min(1),
		body: z.string(),
		author: z.string().min(1),
		created_at: z.number().int(),
	})
	.passthrough();
export type ForumMessage = z.infer<typeof ForumMessageSchema>;

export const PromptFrontmatterSchema = z
	.object({
		cli: z.string().optional(),
		model: z.string().optional(),
		reasoning: z.string().optional(),
		description: z.string().optional(),
	})
	.passthrough();
export type PromptFrontmatter = z.infer<typeof PromptFrontmatterSchema>;
