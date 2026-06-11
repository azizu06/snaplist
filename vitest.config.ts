import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Mirror tsconfig's "@/*" -> "./src/*" so tests can exercise app-layer
    // modules (route handlers) that use the Next-style alias.
    alias: {
      "@": path.resolve(__dirname, "src"),
      // "server-only" throws outside a real RSC bundler; tests run in node.
      // The build-time guarantee it provides is enforced by `next build`, not here.
      "server-only": path.resolve(__dirname, "src/test/server-only-stub.ts"),
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
