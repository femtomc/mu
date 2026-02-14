import { forumHello } from "@mu/forum";
import { issueHello } from "@mu/issue";

export function orchestratorHello(): string {
	return `orchestrator(${forumHello()},${issueHello()})`;
}
