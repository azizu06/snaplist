import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3219);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${port}`;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "output/playwright/test-results",
  fullyParallel: false,
  // SnapList's keyless dev-preview routes are intentionally captured serially:
  // concurrent Next/Clerk bootstrap navigations can race and return the wrong
  // fixture shell even though each route is deterministic in isolation.
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ["list"],
    ["html", { outputFolder: "output/playwright/report", open: "never" }],
  ],
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "mobile-light",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        colorScheme: "light",
        contextOptions: { reducedMotion: "no-preference" },
      },
    },
    {
      name: "mobile-dark-reduced",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        colorScheme: "dark",
        contextOptions: { reducedMotion: "reduce" },
      },
    },
    {
      name: "desktop-light",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        colorScheme: "light",
        contextOptions: { reducedMotion: "no-preference" },
      },
    },
    {
      name: "desktop-dark-reduced",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        colorScheme: "dark",
        contextOptions: { reducedMotion: "reduce" },
      },
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: `pnpm dev --hostname 0.0.0.0 --port ${port}`,
        url: `${baseURL}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
          ...process.env,
          NEXT_TELEMETRY_DISABLED: "1",
          PREVIEW_SIGNED_IN: "1",
          NEXT_PUBLIC_SUPABASE_URL:
            process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321",
          NEXT_PUBLIC_SUPABASE_ANON_KEY:
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "preview-anon-key",
        },
      },
});
