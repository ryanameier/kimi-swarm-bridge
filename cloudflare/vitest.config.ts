import { defineConfig } from "vitest/config";

// Unit tests run in Node with the Workers runtime pieces injected (see test/helpers.ts).
export default defineConfig({
	test: { include: ["test/**/*.test.ts"], setupFiles: ["test/setup.ts"] },
});
