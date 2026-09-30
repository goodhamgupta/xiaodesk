import chalk from 'chalk';
import Table from 'cli-table3';
import type { DashboardState, JobResult, GuestState, QueueStats } from '../types.js';

export function renderDashboard(state: DashboardState): string {
  const lines: string[] = [];
  
  lines.push('');
  lines.push(chalk.bold.cyan('╔════════════════════════════════════════════════════════════════╗'));
  lines.push(chalk.bold.cyan('║') + chalk.bold.white('       🖥️  MicroVM Workshop - Orchestrator Dashboard       ') + chalk.bold.cyan('║'));
  lines.push(chalk.bold.cyan('╚════════════════════════════════════════════════════════════════╝'));
  lines.push('');

  lines.push(renderStats(state.stats));
  lines.push('');
  lines.push(renderMemory(state));
  lines.push('');
  lines.push(renderActiveGuests(state.active_guests));
  lines.push('');
  lines.push(renderRecentResults(state.recent_results));
  
  return lines.join('\n');
}

function renderStats(stats: QueueStats): string {
  const table = new Table({
    head: [
      chalk.white('Queued'),
      chalk.white('Running'),
      chalk.green('Passed'),
      chalk.red('Failed'),
      chalk.yellow('Timeout'),
      chalk.gray('Cancelled'),
    ],
    style: { head: [], border: ['gray'] },
  });

  table.push([
    chalk.cyan(stats.pending.toString()),
    chalk.blue(stats.running.toString()),
    chalk.green(stats.passed.toString()),
    chalk.red(stats.failed.toString()),
    chalk.yellow(stats.timeout.toString()),
    chalk.gray(stats.cancelled.toString()),
  ]);

  return chalk.bold('📊 Queue Statistics\n') + table.toString();
}

function renderMemory(state: DashboardState): string {
  const { config, memory_usage_mb, active_guests } = state;
  const totalUsable = config.total_memory_budget_mb - config.reserved_host_memory_mb;
  const usedPercent = Math.round((memory_usage_mb / totalUsable) * 100);
  
  const barWidth = 40;
  const filledWidth = Math.round((usedPercent / 100) * barWidth);
  const emptyWidth = barWidth - filledWidth;
  
  let barColor = chalk.green;
  if (usedPercent > 80) barColor = chalk.red;
  else if (usedPercent > 60) barColor = chalk.yellow;
  
  const bar = barColor('█'.repeat(filledWidth)) + chalk.gray('░'.repeat(emptyWidth));
  
  const lines = [
    chalk.bold('💾 Memory Usage'),
    `  ${bar} ${usedPercent}%`,
    `  ${chalk.cyan(memory_usage_mb + 'MB')} used / ${chalk.white(totalUsable + 'MB')} available`,
    `  ${chalk.gray('Reserved for host:')} ${config.reserved_host_memory_mb}MB`,
    `  ${chalk.gray('Per guest:')} ${config.memory_per_guest_mb}MB × ${active_guests.length} active`,
  ];
  
  return lines.join('\n');
}

function renderActiveGuests(guests: GuestState[]): string {
  if (guests.length === 0) {
    return chalk.bold('🏃 Active Guests\n') + chalk.gray('  No active guests');
  }

  const table = new Table({
    head: [
      chalk.white('Guest ID'),
      chalk.white('Job'),
      chalk.white('Status'),
      chalk.white('Memory'),
      chalk.white('Runtime'),
    ],
    style: { head: [], border: ['gray'] },
    colWidths: [15, 25, 12, 10, 12],
  });

  for (const guest of guests) {
    const runtime = Math.round((Date.now() - guest.started_at.getTime()) / 1000);
    const statusColor = guest.status === 'running' ? chalk.green : chalk.yellow;
    
    table.push([
      chalk.cyan(guest.id.slice(0, 12)),
      guest.job_name.slice(0, 23),
      statusColor(guest.status),
      `${guest.memory_mb}MB`,
      `${runtime}s`,
    ]);
  }

  return chalk.bold('🏃 Active Guests\n') + table.toString();
}

function renderRecentResults(results: JobResult[]): string {
  if (results.length === 0) {
    return chalk.bold('📋 Recent Results\n') + chalk.gray('  No completed jobs yet');
  }

  const table = new Table({
    head: [
      chalk.white('Job ID'),
      chalk.white('Status'),
      chalk.white('Duration'),
      chalk.white('Evals'),
    ],
    style: { head: [], border: ['gray'] },
    colWidths: [20, 12, 12, 20],
  });

  for (const result of results.slice(0, 8)) {
    const statusIcon = result.status === 'passed' ? chalk.green('✓ PASS') :
                       result.status === 'failed' ? chalk.red('✗ FAIL') :
                       result.status === 'timeout' ? chalk.yellow('⏱ TIMEOUT') :
                       chalk.gray(result.status);
    
    const duration = result.duration_ms ? `${Math.round(result.duration_ms / 1000)}s` : '-';
    
    const evalSummary = result.eval_results 
      ? `${result.eval_results.filter(e => e.passed).length}/${result.eval_results.length}`
      : '-';

    table.push([
      result.job_id.slice(0, 18),
      statusIcon,
      duration,
      evalSummary,
    ]);
  }

  return chalk.bold('📋 Recent Results\n') + table.toString();
}

export function renderJobResult(result: JobResult): string {
  const lines: string[] = [];
  
  const statusIcon = result.status === 'passed' ? chalk.green('✓') :
                     result.status === 'failed' ? chalk.red('✗') :
                     chalk.yellow('⚠');
  
  lines.push(`${statusIcon} Job ${chalk.cyan(result.job_id)} - ${chalk.bold(result.status.toUpperCase())}`);
  
  if (result.duration_ms) {
    lines.push(`  Duration: ${Math.round(result.duration_ms / 1000)}s`);
  }
  
  if (result.error) {
    lines.push(`  ${chalk.red('Error:')} ${result.error}`);
  }
  
  if (result.eval_results) {
    lines.push('  Eval Results:');
    for (const check of result.eval_results) {
      const icon = check.passed ? chalk.green('✓') : chalk.red('✗');
      lines.push(`    ${icon} ${check.name}`);
      if (!check.passed && check.error) {
        lines.push(`      ${chalk.gray(check.error)}`);
      }
    }
  }
  
  return lines.join('\n');
}

export function clearScreen(): void {
  process.stdout.write('\x1B[2J\x1B[0f');
}
