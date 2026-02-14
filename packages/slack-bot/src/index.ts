import { orchestratorHello } from "@mu/orchestrator";

export function slackBotHello(): string {
	return `slack-bot(${orchestratorHello()})`;
}
