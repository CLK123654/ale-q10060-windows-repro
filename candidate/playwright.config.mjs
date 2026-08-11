import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  outputDir: path.resolve(process.cwd(), ".playwright-artifacts"),
  timeout: 30_000,
  expect: { timeout: 5_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [["line"]],
  use: {
    baseURL: "http://127.0.0.1:5190",
    acceptDownloads: true,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    viewport: { width: 1280, height: 900 },
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "node tools/static-server.mjs app 5190",
    cwd: process.cwd(),
    url: "http://127.0.0.1:5190/creator_studio.html",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});

