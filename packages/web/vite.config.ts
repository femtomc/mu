import { defineConfig } from "vite";

export default defineConfig({
	server: {
		fs: {
			// Allow importing workspace packages from ../..
			allow: ["..", "../.."],
		},
	},
});

