import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  retries: 1,
  use: {
    // Chrome extension cần persistent context để giữ extension giữa các test
    headless: false,
    viewport: { width: 1280, height: 720 },
    actionTimeout: 15_000,
  },
  // Extension path — build trước khi chạy: npm run build
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        launchOptions: {
          args: [
            `--disable-extensions-except=${process.cwd()}/dist`,
            `--load-extension=${process.cwd()}/dist`,
            "--disable-web-security",
          ],
        },
      },
    },
  ],
});
