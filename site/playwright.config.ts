import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // В GitHub Actions добавляем отчёт-артефакт (со скриншотами и трейсами падений)
  // и аннотации прямо в интерфейсе Actions; локально — только список в консоли.
  reporter: process.env.CI
    ? [['github'], ['list'], ['html', { open: 'never' }]]
    : [['list']],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 4,
  use: {
    baseURL: 'http://127.0.0.1:8080',
    trace: 'retain-on-failure',
    reducedMotion: 'reduce',
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'python3 server.py',
    url: 'http://127.0.0.1:8080',
    reuseExistingServer: !process.env.CI,
  },
});
