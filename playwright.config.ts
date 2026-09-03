import { defineConfig, devices } from "@playwright/test";

const bunExecutable = process.env["MARKDOWN_REVIEW_BUN"] ?? "bun";
const browserPort = Number(process.env["MARKDOWN_REVIEW_PORT"] ?? 43_117);
const browserOrigin = `http://127.0.0.1:${String(browserPort)}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? "github" : "line",
  use: {
    baseURL: browserOrigin,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `${bunExecutable} scripts/build.ts && ${bunExecutable} tests/harness/browser-harness.ts --generated-fixture`,
    url: `${browserOrigin}/health`,
    reuseExistingServer: !process.env["CI"],
    timeout: 30_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
    { name: "mobile-webkit", testMatch: /dyna\.spec\.ts/, use: { ...devices["iPhone 13"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
});
