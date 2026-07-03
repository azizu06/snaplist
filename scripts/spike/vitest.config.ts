import { defineConfig } from "vitest/config";

// The root vitest config only includes src/**; the spike keeps everything —
// including its tests — inside scripts/spike/. Run with:
//   pnpm vitest run --config scripts/spike/vitest.config.ts
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["scripts/spike/**/*.test.ts"],
  },
});
