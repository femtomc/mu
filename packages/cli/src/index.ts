import { orchestratorHello } from "@mu/orchestrator";

export function run(argv: string[]): string {
	if (argv.includes("--help") || argv.includes("-h")) {
		return helpText();
	}

	if (argv.includes("--version")) {
		return "mu 0.0.0";
	}

	return `mu (placeholder) :: ${orchestratorHello()}`;
}

function helpText(): string {
	return ["mu (placeholder)", "", "Usage:", "  mu [--help] [--version]"].join("\n");
}
