import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { gradeWorkbook, readOds } from '../packages/evals/src/checkers/ods.js';

const fixtures = process.env.FIXTURES_URL || 'http://127.0.0.1:4317';
const dbPath = 'apps/fixtures/data/fixtures.db';

interface Grade {
  pack: string;
  email?: string;
  name?: string;
  plan?: string;
  ticket_id?: string;
  status?: string;
  assignee?: string;
  priority?: string;
  tags?: string[];
  reply?: string;
  guest_email?: string;
  guest_name?: string;
  party_size?: number;
  date?: string;
  has_accessibility?: number;
  price_per_hour_lte?: number;
}

interface TaskFile {
  id: string;
  kind?: string;
  expect?: Parameters<typeof gradeWorkbook>[1];
  grade?: Grade;
  browser_task?: string;
  calc_task?: string;
}

function sql(query: string): Array<Record<string, unknown>> {
  const out = execFileSync('python3', ['-c', `
import json, sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.row_factory = sqlite3.Row
print(json.dumps([dict(row) for row in con.execute(sys.argv[2])]))
`, dbPath, query], { encoding: 'utf8' });
  return JSON.parse(out) as Array<Record<string, unknown>>;
}

async function gradeBrowser(task: TaskFile): Promise<string[]> {
  const grade = task.grade;
  if (!grade) return ['browser task has no grade block'];
  if (grade.pack === 'onboarding') {
    const email = grade.email?.replaceAll("'", "''");
    const users = sql(`SELECT name, email, plan, terms_accepted_at FROM users WHERE email = '${email}'`);
    const errors: string[] = [];
    const user = users[0];
    if (!user) return [`no user ${grade.email}`];
    if (user.name !== grade.name) errors.push(`name ${user.name}`);
    if (user.plan !== grade.plan) errors.push(`plan ${user.plan}`);
    if (!user.terms_accepted_at) errors.push('terms_accepted_at empty');
    const sessions = sql(`SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = '${email}'`);
    if (sessions.length < 1) errors.push('no session');
    const downloads = sql(`SELECT wd.id FROM welcome_downloads wd JOIN users u ON u.id = wd.user_id WHERE u.email = '${email}' AND wd.filename = 'welcome-guide.pdf'`);
    if (downloads.length < 1) errors.push('welcome PDF missing');
    return errors;
  }
  if (grade.pack === 'support') {
    const response = await fetch(`${fixtures}/support/api/ticket/${grade.ticket_id}`);
    if (!response.ok) return [`ticket HTTP ${response.status}`];
    const ticket = await response.json() as {
      status: string;
      assignee: string | null;
      priority: string;
      tags: string[];
      replies: Array<{ content: string }>;
    };
    const errors: string[] = [];
    if (ticket.status !== grade.status) errors.push(`status ${ticket.status}`);
    if (grade.assignee && ticket.assignee !== grade.assignee) errors.push(`assignee ${ticket.assignee}`);
    if (grade.priority && ticket.priority !== grade.priority) errors.push(`priority ${ticket.priority}`);
    if (grade.tags && JSON.stringify(ticket.tags) !== JSON.stringify(grade.tags)) {
      errors.push(`tags ${JSON.stringify(ticket.tags)}`);
    }
    if (grade.reply && !(ticket.replies || []).some((reply) => reply.content === grade.reply)) {
      errors.push('reply missing');
    }
    return errors;
  }
  if (grade.pack === 'booking') {
    const response = await fetch(`${fixtures}/booking/api/reservations?guest_email=${encodeURIComponent(grade.guest_email || '')}`);
    if (!response.ok) return [`reservations HTTP ${response.status}`];
    const body = await response.json() as {
      count: number;
      reservations: Array<{ party_size: number; date: string; guest_name: string; has_accessibility: number; price_per_hour: number; confirmed: number }>;
    };
    const row = body.reservations?.[0];
    if (!row || body.count < 1) return ['no reservation'];
    const errors: string[] = [];
    if (row.party_size !== grade.party_size) errors.push(`party_size ${row.party_size}`);
    if (row.date !== grade.date) errors.push(`date ${row.date}`);
    if (grade.guest_name && row.guest_name !== grade.guest_name) errors.push(`guest_name ${row.guest_name}`);
    if (grade.has_accessibility !== undefined && row.has_accessibility !== grade.has_accessibility) {
      errors.push(`accessibility ${row.has_accessibility}`);
    }
    if (grade.price_per_hour_lte !== undefined && row.price_per_hour > grade.price_per_hour_lte) {
      errors.push(`price ${row.price_per_hour}`);
    }
    if (row.confirmed !== 1) errors.push('not confirmed');
    return errors;
  }
  return [`unknown browser pack ${grade.pack}`];
}

function gradeCalc(id: string, task: TaskFile): string[] {
  if (!task.expect) return ['calc task has no expect'];
  return gradeWorkbook(readOds(readFileSync(`runs/artifacts/${id}.ods`)), task.expect);
}

async function gradeId(id: string): Promise<string[]> {
  const task = JSON.parse(readFileSync(`tasks/osworld/${id}.json`, 'utf8')) as TaskFile;
  if (task.kind === 'browser') return gradeBrowser(task);
  if (task.kind === 'workflow') {
    const errors: string[] = [];
    if (task.browser_task) errors.push(...(await gradeId(task.browser_task)).map((error) => `${task.browser_task}: ${error}`));
    if (task.calc_task) errors.push(...gradeCalc(task.calc_task, JSON.parse(readFileSync(`tasks/osworld/${task.calc_task}.json`, 'utf8')) as TaskFile).map((error) => `${task.calc_task}: ${error}`));
    return errors;
  }
  return gradeCalc(id, task);
}

const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error('usage: tsx scripts/grade-osworld.ts calc-revenue browse-onboarding ...');
  process.exit(2);
}

let failed = 0;
for (const id of ids) {
  try {
    const errors = await gradeId(id);
    if (errors.length === 0) {
      console.log(`PASS ${id}`);
    } else {
      failed += 1;
      console.log(`FAIL ${id}`);
      for (const error of errors) console.log(`  ${error}`);
    }
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${id} ${error instanceof Error ? error.message : error}`);
  }
}
process.exit(failed === 0 ? 0 : 1);
