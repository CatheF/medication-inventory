import path from "node:path";
import { defineConfig } from "vitest/config";

// Unit + API-route tests run in plain Node. Browser/E2E tests use Playwright (playwright.config.ts).
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname) },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/api/**/*.test.ts"],
    clearMocks: true,
    restoreMocks: true,
  },
});
