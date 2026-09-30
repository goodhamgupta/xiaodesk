import { db } from '../db/schema.js';

export function seedVenues() {
  const venues = [
    { id: 'venue-grand', name: 'The Grand Ballroom', description: 'Elegant space for large events', capacity: 200, price_per_hour: 500, has_accessibility: 1, amenities: JSON.stringify(['wifi', 'stage', 'catering', 'parking']) },
    { id: 'venue-rooftop', name: 'Rooftop Terrace', description: 'Open-air venue with city views', capacity: 75, price_per_hour: 350, has_accessibility: 1, amenities: JSON.stringify(['wifi', 'bar', 'heaters']) },
    { id: 'venue-cozy', name: 'The Cozy Corner', description: 'Intimate setting for small gatherings', capacity: 25, price_per_hour: 150, has_accessibility: 0, amenities: JSON.stringify(['wifi', 'kitchenette']) },
    { id: 'venue-tech', name: 'Tech Hub Conference Room', description: 'Modern space with full AV setup', capacity: 50, price_per_hour: 200, has_accessibility: 1, amenities: JSON.stringify(['wifi', 'projector', 'video_conf', 'whiteboard']) },
    { id: 'venue-garden', name: 'Garden Pavilion', description: 'Outdoor venue surrounded by nature', capacity: 100, price_per_hour: 400, has_accessibility: 1, amenities: JSON.stringify(['outdoor', 'tent', 'parking']) },
    { id: 'venue-loft', name: 'The Loft Studio', description: 'Industrial-chic creative space', capacity: 40, price_per_hour: 175, has_accessibility: 0, amenities: JSON.stringify(['wifi', 'sound_system', 'lighting']) },
  ];

  const insert = db.prepare(`
    INSERT INTO venues (id, name, description, capacity, price_per_hour, has_accessibility, amenities)
    VALUES (@id, @name, @description, @capacity, @price_per_hour, @has_accessibility, @amenities)
  `);

  for (const venue of venues) {
    insert.run(venue);
  }

  return venues;
}

export function seedTimeSlots(venues: Array<{ id: string }>) {
  const insert = db.prepare(`
    INSERT INTO time_slots (id, venue_id, date, start_time, end_time, is_available)
    VALUES (@id, @venue_id, @date, @start_time, @end_time, @is_available)
  `);

  const dates = ['2024-03-15', '2024-03-16', '2024-03-17', '2024-03-18', '2024-03-19'];
  const timeRanges = [
    { start: '09:00', end: '12:00' },
    { start: '13:00', end: '16:00' },
    { start: '17:00', end: '20:00' },
    { start: '20:00', end: '23:00' },
  ];

  for (const venue of venues) {
    for (const date of dates) {
      for (const time of timeRanges) {
        insert.run({
          id: `${venue.id}-${date}-${time.start}`,
          venue_id: venue.id,
          date,
          start_time: time.start,
          end_time: time.end,
          is_available: 1,
        });
      }
    }
  }
}

export function seedTickets() {
  const tickets = [
    { id: 'TKT-001', subject: 'Cannot access dashboard', description: 'Login works but dashboard shows blank page. Tried clearing cache.', status: 'open', priority: 'high', tags: JSON.stringify(['bug', 'dashboard']), assignee: null, customer_email: 'alice@example.com' },
    { id: 'TKT-002', subject: 'Billing question about upgrade', description: 'I upgraded to Pro last week but still see Basic features. When does it activate?', status: 'open', priority: 'medium', tags: JSON.stringify(['billing', 'upgrade']), assignee: null, customer_email: 'bob@example.com' },
    { id: 'TKT-003', subject: 'Feature request: dark mode', description: 'Would love a dark mode option for the app. Eyes get tired after long sessions.', status: 'open', priority: 'low', tags: JSON.stringify(['feature-request', 'ui']), assignee: null, customer_email: 'carol@example.com' },
    { id: 'TKT-004', subject: 'Export not working', description: 'CSV export button does nothing when clicked. Using Chrome on Windows.', status: 'open', priority: 'high', tags: JSON.stringify(['bug', 'export']), assignee: 'support-team', customer_email: 'dave@example.com' },
    { id: 'TKT-005', subject: 'Account deletion request', description: 'Please delete my account and all associated data per GDPR.', status: 'open', priority: 'high', tags: JSON.stringify(['account', 'gdpr', 'urgent']), assignee: null, customer_email: 'eve@example.com' },
    { id: 'TKT-006', subject: 'API rate limits', description: 'We are hitting rate limits on the API. Can our quota be increased?', status: 'in-progress', priority: 'medium', tags: JSON.stringify(['api', 'quota']), assignee: 'dev-team', customer_email: 'frank@example.com' },
    { id: 'TKT-007', subject: 'Password reset not received', description: 'Requested password reset 3 times, no email received. Not in spam folder.', status: 'open', priority: 'high', tags: JSON.stringify(['auth', 'email']), assignee: null, customer_email: 'grace@example.com' },
    { id: 'TKT-008', subject: 'Integration with Slack', description: 'Does the platform integrate with Slack? Looking for notifications support.', status: 'open', priority: 'low', tags: JSON.stringify(['feature-request', 'integration']), assignee: null, customer_email: 'henry@example.com' },
    { id: 'TKT-009', subject: 'Mobile app crashes on launch', description: 'iOS app crashes immediately after splash screen. iPhone 14, iOS 17.2', status: 'open', priority: 'critical', tags: JSON.stringify(['bug', 'mobile', 'crash']), assignee: null, customer_email: 'iris@example.com' },
    { id: 'TKT-010', subject: 'Duplicate charges on invoice', description: 'My March invoice shows two charges for the same subscription. Please refund duplicate.', status: 'open', priority: 'high', tags: JSON.stringify(['billing', 'refund']), assignee: null, customer_email: 'jack@example.com' },
  ];

  const insert = db.prepare(`
    INSERT INTO tickets (id, subject, description, status, priority, tags, assignee, customer_email)
    VALUES (@id, @subject, @description, @status, @priority, @tags, @assignee, @customer_email)
  `);

  for (const ticket of tickets) {
    insert.run(ticket);
  }
}

export function seedAll() {
  const venues = seedVenues();
  seedTimeSlots(venues);
  seedTickets();
  console.log('Seeded: venues, time_slots, tickets');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedAll();
}
