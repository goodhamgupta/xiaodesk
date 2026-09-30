import { chromium, type Browser, type Page, type BrowserContext } from 'playwright';

export interface BrowserConfig {
  mode: 'chromium' | 'lightpanda';
  cdpEndpoint?: string;
  headless?: boolean;
}

export interface BrowserTool {
  launch(): Promise<void>;
  close(): Promise<void>;
  navigate(url: string): Promise<{ url: string; title: string }>;
  click(selector: string): Promise<{ clicked: boolean }>;
  fill(selector: string, value: string): Promise<{ filled: boolean }>;
  select(selector: string, value: string): Promise<{ selected: boolean }>;
  check(selector: string): Promise<{ checked: boolean }>;
  getText(selector: string): Promise<{ text: string }>;
  getAttribute(selector: string, attr: string): Promise<{ value: string | null }>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<{ found: boolean }>;
  screenshot(path?: string): Promise<{ path: string } | { base64: string }>;
  evaluate<T>(script: string): Promise<T>;
  getCookies(): Promise<Array<{ name: string; value: string; domain: string }>>;
  getPage(): Page | null;
  currentUrl(): string;
}

export class PlaywrightBrowserTool implements BrowserTool {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private config: BrowserConfig;

  constructor(config: BrowserConfig) {
    this.config = config;
  }

  async launch(): Promise<void> {
    if (this.config.mode === 'lightpanda' && this.config.cdpEndpoint) {
      this.browser = await chromium.connectOverCDP(this.config.cdpEndpoint);
      const contexts = this.browser.contexts();
      this.context = contexts[0] || await this.browser.newContext();
    } else {
      this.browser = await chromium.launch({
        headless: this.config.headless ?? true,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      });
      this.context = await this.browser.newContext();
    }
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(20_000);
  }

  async close(): Promise<void> {
    await this.page?.close();
    await this.context?.close();
    await this.browser?.close();
    this.page = null;
    this.context = null;
    this.browser = null;
  }

  async navigate(url: string): Promise<{ url: string; title: string }> {
    if (!this.page) throw new Error('Browser not launched');
    if (url.includes('/download')) {
      const response = await this.page.request.get(url, { timeout: 20_000 });
      if (!response.ok()) throw new Error(`download failed: HTTP ${response.status()}`);
      return { url, title: 'downloaded' };
    }
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    return { url: this.page.url(), title: await this.page.title() };
  }

  async click(selector: string): Promise<{ clicked: boolean }> {
    if (!this.page) throw new Error('Browser not launched');
    await this.page.click(selector, { timeout: 15_000 });
    return { clicked: true };
  }

  async fill(selector: string, value: string): Promise<{ filled: boolean }> {
    if (!this.page) throw new Error('Browser not launched');
    await this.page.fill(selector, value);
    return { filled: true };
  }

  async select(selector: string, value: string): Promise<{ selected: boolean }> {
    if (!this.page) throw new Error('Browser not launched');
    await this.page.selectOption(selector, value);
    return { selected: true };
  }

  async check(selector: string): Promise<{ checked: boolean }> {
    if (!this.page) throw new Error('Browser not launched');
    await this.page.check(selector);
    return { checked: true };
  }

  async getText(selector: string): Promise<{ text: string }> {
    if (!this.page) throw new Error('Browser not launched');
    const text = await this.page.textContent(selector);
    return { text: text || '' };
  }

  async getAttribute(selector: string, attr: string): Promise<{ value: string | null }> {
    if (!this.page) throw new Error('Browser not launched');
    const value = await this.page.getAttribute(selector, attr);
    return { value };
  }

  async waitForSelector(selector: string, options?: { timeout?: number }): Promise<{ found: boolean }> {
    if (!this.page) throw new Error('Browser not launched');
    try {
      await this.page.waitForSelector(selector, { timeout: options?.timeout || 30000 });
      return { found: true };
    } catch {
      return { found: false };
    }
  }

  async screenshot(path?: string): Promise<{ path: string } | { base64: string }> {
    if (!this.page) throw new Error('Browser not launched');
    if (path) {
      await this.page.screenshot({ path });
      return { path };
    } else {
      const buffer = await this.page.screenshot();
      return { base64: buffer.toString('base64') };
    }
  }

  async evaluate<T>(script: string): Promise<T> {
    if (!this.page) throw new Error('Browser not launched');
    return await this.page.evaluate(script) as T;
  }

  async getCookies(): Promise<Array<{ name: string; value: string; domain: string }>> {
    if (!this.context) throw new Error('Browser not launched');
    const cookies = await this.context.cookies();
    return cookies.map(c => ({ name: c.name, value: c.value, domain: c.domain }));
  }

  getPage(): Page | null {
    return this.page;
  }

  currentUrl(): string {
    return this.page?.url() ?? '';
  }
}

export function createBrowserTool(config: BrowserConfig): BrowserTool {
  return new PlaywrightBrowserTool(config);
}
