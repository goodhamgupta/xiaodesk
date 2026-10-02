import assert from 'node:assert/strict';
import test from 'node:test';
import { taskSurface, taskUrl } from './paint-desktop.mjs';

test('browser packs point at the fixture page', () => {
  assert.equal(taskSurface({ kind: 'browser', pack: 'onboarding' }), 'browser');
  assert.equal(taskUrl({ pack: 'onboarding' }, 'http://10.0.2.2:4317'), 'http://10.0.2.2:4317/onboarding');
  assert.equal(
    taskUrl({ pack: 'support', params: { ticket_id: 'TKT-009' } }, 'http://10.0.2.2:4317/'),
    'http://10.0.2.2:4317/support/ticket/TKT-009',
  );
  assert.equal(
    taskUrl({
      pack: 'booking',
      params: { date: '2024-03-15', party_size: 40, max_price: 300, accessibility: true },
    }, 'http://10.0.2.2:4317'),
    'http://10.0.2.2:4317/booking?date=2024-03-15&min_capacity=40&max_price=300&accessibility=true',
  );
});

test('calc tasks are the spreadsheet surface', () => {
  assert.equal(taskSurface({ csv: 'A,B\n1,2', ods_name: 'regional-sales.ods' }), 'calc');
  assert.equal(taskSurface({ kind: 'noop' }), '');
});
