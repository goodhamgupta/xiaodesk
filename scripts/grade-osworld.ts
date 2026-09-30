import { readFileSync } from 'fs';
import { gradeWorkbook, readOds } from '../packages/evals/src/checkers/ods.js';

const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error('usage: tsx scripts/grade-osworld.ts calc-revenue ...');
  process.exit(2);
}

let failed = 0;
for (const id of ids) {
  const task = JSON.parse(readFileSync(`tasks/osworld/${id}.json`, 'utf8')) as { expect: Parameters<typeof gradeWorkbook>[1] };
  try {
    const errors = gradeWorkbook(readOds(readFileSync(`runs/artifacts/${id}.ods`)), task.expect);
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
