import { fileURLToPath } from "node:url";

export const MU_DEFAULT_THEME_NAME = "mu-gruvbox-dark";

function resolveBundledThemePath(name: string): string {
	return fileURLToPath(new URL(`../themes/${name}`, import.meta.url));
}

export const MU_DEFAULT_THEME_PATH = resolveBundledThemePath(`${MU_DEFAULT_THEME_NAME}.json`);
