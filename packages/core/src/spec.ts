import { z } from "zod";

export const DepSchema = z
	.object({
		type: z.string().min(1),
		target: z.string().min(1),
	})
	.strict();
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
		priority: z.number().int(),
		created_at: z.number().int(),
		updated_at: z.number().int(),
	})
	.strict();
export type Issue = z.infer<typeof IssueSchema>;

export const ForumMessageSchema = z
	.object({
		topic: z.string().min(1),
		body: z.string(),
		author: z.string().min(1),
		created_at: z.number().int(),
	})
	.strict();
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
