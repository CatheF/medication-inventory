import { defineConfig } from "@playwright/test";

// Browser tests run against a running app with /api/* intercepted (tests/e2e/helpers/mock-api.ts), so no
// database is needed. Point E2E_BASE_URL at an already-running server, or let Playwright start one.
// In sandboxes with a preinstalled Chromium set CHROMIUM_PATH to its executable.
const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    baseURL,
    viewport: { width: 1280, height: 900 },
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run build && npm run start -- -p 3100",
        url: baseURL,
        reuseExistingServer: true,
        timeout: 300_000,
        env: {
          NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
          NEXT_PUBLIC_SUPABASE_ANON_KEY: "e2e-dummy-key",
        },
      },
});
