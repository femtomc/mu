import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MU_DEFAULT_THEME_NAME = "mu-gruvbox-dark";

function resolveBundledThemePath(name: string): string {
	return fileURLToPath(new URL(`../themes/${name}`, import.meta.url));
}

export const MU_DEFAULT_THEME_PATH = resolveBundledThemePath(`${MU_DEFAULT_THEME_NAME}.json`);

function readPackageVersion(): string {
	try {
		const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
		return pkg.version;
	} catch {
		return "0.0.0";
	}
}

export const MU_VERSION = readPackageVersion();
