import { spawn, type ChildProcess } from 'child_process';
import { createBrowserTool, type BrowserTool } from './browser/browser-tool.js';
import { createMockAppServer } from './app-server/mock-server.js';
import { createStubAgent, type JobCard } from './stub/stub-agent.js';

export interface GuestEvent {
  type: string;
  data: unknown;
}

async function waitForCdp(port: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // server still booting
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Lightpanda CDP did not come up on 127.0.0.1:${port}`);
}

async function launchBrowser(): Promise<{ browser: BrowserTool; lightpanda: ChildProcess | null }> {
  const mode = process.env.BROWSER_MODE || 'chromium';
  const port = process.env.CDP_PORT || '9222';
  const allowFallback = process.env.ALLOW_CHROMIUM_FALLBACK !== 'false';

  if (mode === 'lightpanda') {
    let lightpanda: ChildProcess | null = null;
    try {
      let endpoint = process.env.LIGHTPANDA_CDP || `http://127.0.0.1:${port}`;
      if (process.env.LIGHTPANDA_BIN) {
        lightpanda = spawn(process.env.LIGHTPANDA_BIN, ['serve', '--host', '127.0.0.1', '--port', port], {
          env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: 'true' },
          stdio: 'ignore',
        });
        endpoint = `http://127.0.0.1:${port}`;
        await waitForCdp(port);
      }
      const browser = createBrowserTool({ mode: 'lightpanda', cdpEndpoint: endpoint, headless: true });
      await browser.launch();
      console.error(`browser: lightpanda via ${endpoint}`);
      return { browser, lightpanda };
    } catch (error) {
      if (!allowFallback) throw error;
      console.error(`Lightpanda unavailable (${error instanceof Error ? error.message : error}). Falling back to Playwright Chromium.`);
    }
  }

  const headed = process.env.BROWSER_HEADLESS === 'false';
  const browser = createBrowserTool({ mode: 'chromium', headless: !headed });
  await browser.launch();
  console.error('browser: playwright chromium');
  return { browser, lightpanda: null };
}

export async function runGuestJob(job: JobCard, onEvent?: (event: GuestEvent) => void): Promise<void> {
  let browser: BrowserTool | null = null;
  let lightpanda: ChildProcess | null = null;
  try {
    const launched = await launchBrowser();
    browser = launched.browser;
    lightpanda = launched.lightpanda;
    const agent = createStubAgent({
      fixturesUrl: process.env.FIXTURES_URL || 'http://127.0.0.1:4317',
      browserTool: browser,
      appServer: createMockAppServer(),
    });
    for await (const event of agent.run(job)) {
      onEvent?.({ type: event.type, data: event.data });
    }
  } finally {
    await browser?.close().catch(() => undefined);
    if (lightpanda) lightpanda.kill('SIGTERM');
  }
}
