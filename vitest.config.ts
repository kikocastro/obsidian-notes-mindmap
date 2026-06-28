import { defineConfig } from "vitest/config";

// Pure logic only (src/graph.ts is Obsidian-free), so the default node env is enough.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "text-summary"],
      thresholds: { lines: 80, functions: 80, statements: 80 },
    },
  },
});
