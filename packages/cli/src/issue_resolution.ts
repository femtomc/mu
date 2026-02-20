import type { IssueStore } from "@femtomc/mu-issue";

export async function resolveIssueId(
	store: IssueStore,
	rawId: string,
	deps: { formatRecovery: (recovery?: readonly string[] | null) => string },
): Promise<{ issueId: string | null; error: string | null }> {
	const direct = await store.get(rawId);
	if (direct) {
		return { issueId: direct.id, error: null };
	}

	const all = await store.list();
	const matches = all.map((i) => i.id).filter((id) => id.startsWith(rawId));
	if (matches.length === 0) {
		return {
			issueId: null,
			error:
				`not found: ${rawId}` +
				deps.formatRecovery(["mu issues list --limit 20", "mu issues ready --root <root-id>", "mu status"]),
		};
	}
	if (matches.length > 1) {
		const sample = matches.slice(0, 5).join(",");
		const suffix = matches.length > 5 ? "..." : "";
		return {
			issueId: null,
			error:
				`ambiguous id prefix: ${rawId} (${sample}${suffix})` +
				deps.formatRecovery(["use a longer id prefix", "mu issues list --limit 20"]),
		};
	}
	return { issueId: matches[0]!, error: null };
}
