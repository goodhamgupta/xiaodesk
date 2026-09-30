import type { BrowserTool } from '../browser/browser-tool.js';
import type { MockAppServer, StubAction, AgentEvent } from '../app-server/mock-server.js';

export interface JobCard {
  id: string;
  pack: 'onboarding' | 'support' | 'booking';
  name: string;
  goal: string;
  params: Record<string, unknown>;
}

export interface StubAgentConfig {
  fixturesUrl: string;
  browserTool: BrowserTool;
  appServer: MockAppServer;
}

export class StubAgent {
  private config: StubAgentConfig;
  private actionScripts: Map<string, (job: JobCard) => StubAction[]> = new Map();

  constructor(config: StubAgentConfig) {
    this.config = config;
    this.registerDefaultScripts();
    this.registerBrowserTools();
  }

  private registerBrowserTools(): void {
    const { browserTool, appServer } = this.config;

    appServer.registerTool('browser_navigate', async (args) => {
      return browserTool.navigate(args.url as string);
    });

    appServer.registerTool('browser_click', async (args) => {
      return browserTool.click(args.selector as string);
    });

    appServer.registerTool('browser_fill', async (args) => {
      return browserTool.fill(args.selector as string, args.value as string);
    });

    appServer.registerTool('browser_select', async (args) => {
      return browserTool.select(args.selector as string, args.value as string);
    });

    appServer.registerTool('browser_check', async (args) => {
      return browserTool.check(args.selector as string);
    });

    appServer.registerTool('browser_get_text', async (args) => {
      return browserTool.getText(args.selector as string);
    });

    appServer.registerTool('browser_wait', async (args) => {
      return browserTool.waitForSelector(args.selector as string, { timeout: args.timeout as number });
    });

    appServer.registerTool('browser_screenshot', async (args) => {
      return browserTool.screenshot(args.path as string | undefined);
    });
  }

  private registerDefaultScripts(): void {
    this.actionScripts.set('onboarding', (job) => this.onboardingScript(job));
    this.actionScripts.set('support', (job) => this.supportScript(job));
    this.actionScripts.set('booking', (job) => this.bookingScript(job));
  }

  private onboardingScript(job: JobCard): StubAction[] {
    const { name, email, plan } = job.params as { name: string; email: string; plan: string };
    const baseUrl = this.config.fixturesUrl;

    return [
      { tool: 'browser_navigate', args: { url: `${baseUrl}/onboarding` }, description: 'Navigate to onboarding page' },
      { tool: 'browser_wait', args: { selector: '[data-testid="name-input"]' }, description: 'Wait for form to load' },
      { tool: 'browser_fill', args: { selector: '[data-testid="name-input"]', value: name }, description: 'Enter name' },
      { tool: 'browser_fill', args: { selector: '[data-testid="email-input"]', value: email }, description: 'Enter email' },
      { tool: 'browser_click', args: { selector: '[data-testid="continue-btn"]' }, description: 'Submit signup form' },
      { tool: 'browser_wait', args: { selector: `[data-testid="plan-${plan}"]` }, description: 'Wait for plan selection' },
      { tool: 'browser_click', args: { selector: `label.plan:has([data-testid="plan-${plan}"])` }, description: `Select ${plan} plan` },
      { tool: 'browser_click', args: { selector: '[data-testid="continue-btn"]' }, description: 'Continue to terms' },
      { tool: 'browser_wait', args: { selector: '[data-testid="accept-checkbox"]' }, description: 'Wait for terms page' },
      { tool: 'browser_check', args: { selector: '[data-testid="accept-checkbox"]' }, description: 'Accept terms' },
      { tool: 'browser_click', args: { selector: '[data-testid="continue-btn"]' }, description: 'Submit terms' },
      { tool: 'browser_wait', args: { selector: '[data-testid="download-btn"]' }, description: 'Wait for welcome page' },
      { tool: 'browser_navigate', args: { url: `${baseUrl}/onboarding/download-welcome` }, description: 'Download welcome PDF' },
    ];
  }

  private supportScript(job: JobCard): StubAction[] {
    const { ticket_id, status, priority, assignee, tags, reply } = job.params as {
      ticket_id: string;
      status?: string;
      priority?: string;
      assignee?: string;
      tags?: string;
      reply?: string;
    };
    const baseUrl = this.config.fixturesUrl;

    const actions: StubAction[] = [
      { tool: 'browser_navigate', args: { url: `${baseUrl}/support/ticket/${ticket_id}` }, description: 'Navigate to ticket' },
      { tool: 'browser_wait', args: { selector: '[data-testid="status-select"]' }, description: 'Wait for ticket form' },
    ];

    if (status) {
      actions.push({ tool: 'browser_select', args: { selector: '[data-testid="status-select"]', value: status }, description: `Set status to ${status}` });
    }

    if (priority) {
      actions.push({ tool: 'browser_select', args: { selector: '[data-testid="priority-select"]', value: priority }, description: `Set priority to ${priority}` });
    }

    if (assignee) {
      actions.push({ tool: 'browser_select', args: { selector: '[data-testid="assignee-select"]', value: assignee }, description: `Assign to ${assignee}` });
    }

    if (tags) {
      actions.push({ tool: 'browser_fill', args: { selector: '[data-testid="tags-input"]', value: tags }, description: 'Update tags' });
    }

    actions.push({ tool: 'browser_click', args: { selector: '[data-testid="update-ticket"]' }, description: 'Save ticket updates' });

    if (reply) {
      actions.push(
        { tool: 'browser_wait', args: { selector: '[data-testid="reply-input"]' }, description: 'Wait for reply form' },
        { tool: 'browser_fill', args: { selector: '[data-testid="reply-input"]', value: reply }, description: 'Enter reply' },
        { tool: 'browser_click', args: { selector: '[data-testid="submit-reply"]' }, description: 'Submit reply' }
      );
    }

    return actions;
  }

  private bookingScript(job: JobCard): StubAction[] {
    const { date, party_size, max_price, accessibility, guest_name, guest_email } = job.params as {
      date: string;
      party_size: number;
      max_price?: number;
      accessibility?: boolean;
      guest_name: string;
      guest_email: string;
    };
    const baseUrl = this.config.fixturesUrl;

    const filterParams = new URLSearchParams();
    filterParams.set('date', date);
    filterParams.set('min_capacity', String(party_size));
    if (max_price) filterParams.set('max_price', String(max_price));
    if (accessibility) filterParams.set('accessibility', 'true');

    return [
      { tool: 'browser_navigate', args: { url: `${baseUrl}/booking?${filterParams}` }, description: 'Navigate to booking with filters' },
      { tool: 'browser_wait', args: { selector: '.venue' }, description: 'Wait for venues to load' },
      { tool: 'browser_click', args: { selector: '.venue:first-child [class*="btn"]:not(.disabled)' }, description: 'Select first available venue' },
      { tool: 'browser_wait', args: { selector: '.slot' }, description: 'Wait for time slots' },
      { tool: 'browser_click', args: { selector: '.slot:first-child' }, description: 'Select first available slot' },
      { tool: 'browser_fill', args: { selector: '[data-testid="guest-name"]', value: guest_name }, description: 'Enter guest name' },
      { tool: 'browser_fill', args: { selector: '[data-testid="guest-email"]', value: guest_email }, description: 'Enter guest email' },
      { tool: 'browser_fill', args: { selector: '[data-testid="party-size"]', value: String(party_size) }, description: 'Enter party size' },
      { tool: 'browser_click', args: { selector: '[data-testid="confirm-booking"]' }, description: 'Confirm reservation' },
      { tool: 'browser_wait', args: { selector: '[data-testid="confirmation-id"]' }, description: 'Wait for confirmation' },
    ];
  }

  async *run(job: JobCard): AsyncGenerator<AgentEvent> {
    if (job.pack === 'booking') {
      yield* this.runBooking(job);
      return;
    }

    const scriptFn = this.actionScripts.get(job.pack);
    if (!scriptFn) {
      yield { type: 'error', timestamp: new Date(), data: { error: `No script for pack: ${job.pack}` } };
      return;
    }

    const actions = scriptFn(job);
    const thread = await this.config.appServer.threadStart({
      instructions: job.goal,
    });

    for await (const event of this.config.appServer.turnStart({
      thread_id: thread.id,
      user_message: job.goal,
      stubActions: actions,
    })) {
      yield event;
    }
  }

  private async *runBooking(job: JobCard): AsyncGenerator<AgentEvent> {
    const params = job.params as {
      date: string;
      party_size: number;
      max_price?: number;
      accessibility?: boolean;
      guest_name: string;
      guest_email: string;
      force_slot_race?: boolean;
    };
    const browser = this.config.browserTool;
    const baseUrl = this.config.fixturesUrl;
    const filter = new URLSearchParams();
    filter.set('date', params.date);
    filter.set('min_capacity', String(params.party_size));
    if (params.max_price) filter.set('max_price', String(params.max_price));
    if (params.accessibility) filter.set('accessibility', 'true');

    const step = async function* (tool: string, args: Record<string, unknown>, description: string): AsyncGenerator<AgentEvent> {
      yield { type: 'tool_call', timestamp: new Date(), data: { tool, args, description } };
      let result: unknown;
      if (tool === 'browser_navigate') result = await browser.navigate(args.url as string);
      else if (tool === 'browser_click') result = await browser.click(args.selector as string);
      else if (tool === 'browser_fill') result = await browser.fill(args.selector as string, args.value as string);
      else if (tool === 'browser_wait') result = await browser.waitForSelector(args.selector as string);
      else throw new Error(`unknown booking tool ${tool}`);
      yield { type: 'tool_result', timestamp: new Date(), data: { tool, result } };
    };

    yield* step('browser_navigate', { url: `${baseUrl}/booking?${filter}` }, 'Open filtered venue search');
    yield* step('browser_wait', { selector: 'a.btn:not(.disabled)' }, 'Wait for an available venue');
    yield* step('browser_click', { selector: 'a.btn:not(.disabled)' }, 'Select the cheapest matching venue');
    yield* step('browser_wait', { selector: '.slot' }, 'Wait for time slots');

    const page = browser.getPage();
    if (!page) throw new Error('Browser page missing');

    const attempt = async () => {
      const slot = page.locator('.slot').first();
      const slotId = await slot.locator('input').inputValue();
      await slot.click();
      await page.locator('[data-testid="selected-slot-input"]').evaluate((el, id) => {
        (el as { value: string }).value = id;
      }, slotId);
      await browser.fill('[data-testid="guest-name"]', params.guest_name);
      await browser.fill('[data-testid="guest-email"]', params.guest_email);
      await browser.fill('[data-testid="party-size"]', String(params.party_size));
      await Promise.all([
        page.waitForURL(/confirmation\/|slot_unavailable/, { timeout: 15_000 }),
        browser.click('[data-testid="confirm-booking"]'),
      ]);
      return slotId;
    };

    if (params.force_slot_race) {
      const firstId = await page.locator('.slot input').first().inputValue();
      yield { type: 'tool_call', timestamp: new Date(), data: { tool: 'mark_slot_unavailable', args: { slot_id: firstId }, description: 'Slot sells out mid-flow' } };
      const marked = await page.request.post(`${baseUrl}/booking/api/mark-slot-unavailable`, {
        data: { slot_id: firstId },
        headers: { 'content-type': 'application/json' },
      });
      if (!marked.ok()) throw new Error(`failed to mark slot sold out: HTTP ${marked.status()}`);
      yield { type: 'tool_result', timestamp: new Date(), data: { tool: 'mark_slot_unavailable', result: { slot_id: firstId } } };

      yield { type: 'thinking', timestamp: new Date(), data: { content: 'Confirming the slot that was available when the page loaded' } };
      await attempt();
      if (!page.url().includes('slot_unavailable')) {
        throw new Error(`expected the first slot to be sold out, landed on ${page.url()}`);
      }
      yield { type: 'thinking', timestamp: new Date(), data: { content: 'Slot sold out. Backing off and selecting the next slot.' } };
      await new Promise((resolve) => setTimeout(resolve, 400));
      await browser.waitForSelector('.slot');
      const nextId = await page.locator('.slot input').first().inputValue();
      if (nextId === firstId) throw new Error('sold-out slot is still the first choice');
      await attempt();
    } else {
      await attempt();
    }

    yield* step('browser_wait', { selector: '[data-testid="confirmation-id"]' }, 'Wait for confirmation');
    yield { type: 'message', timestamp: new Date(), data: { content: 'Reservation confirmed' } };
    yield { type: 'done', timestamp: new Date(), data: {} };
  }

  registerScript(pack: string, scriptFn: (job: JobCard) => StubAction[]): void {
    this.actionScripts.set(pack, scriptFn);
  }
}

export function createStubAgent(config: StubAgentConfig): StubAgent {
  return new StubAgent(config);
}
