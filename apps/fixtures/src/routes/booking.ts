import { Router, Request, Response } from 'express';
import { db } from '../db/schema.js';
import { v4 as uuid } from 'uuid';

const router = Router();

interface Venue {
  id: string;
  name: string;
  description: string;
  capacity: number;
  price_per_hour: number;
  has_accessibility: boolean;
  amenities: string;
}

interface TimeSlot {
  id: string;
  venue_id: string;
  date: string;
  start_time: string;
  end_time: string;
  is_available: boolean;
}

router.get('/', (req: Request, res: Response) => {
  const { date, min_capacity, max_price, accessibility } = req.query;
  
  let venues = db.prepare('SELECT * FROM venues ORDER BY price_per_hour ASC').all() as Venue[];
  
  if (min_capacity) {
    venues = venues.filter(v => v.capacity >= Number(min_capacity));
  }
  if (max_price) {
    venues = venues.filter(v => v.price_per_hour <= Number(max_price));
  }
  if (accessibility === 'true') {
    venues = venues.filter(v => v.has_accessibility);
  }
  
  const venuesWithSlots = venues.map(venue => {
    let slots: TimeSlot[];
    if (date) {
      slots = db.prepare('SELECT * FROM time_slots WHERE venue_id = ? AND date = ? AND is_available = 1').all(venue.id, date) as TimeSlot[];
    } else {
      slots = db.prepare('SELECT * FROM time_slots WHERE venue_id = ? AND is_available = 1').all(venue.id) as TimeSlot[];
    }
    return { ...venue, amenities: JSON.parse(venue.amenities), availableSlots: slots.length };
  });
  
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Venue Booking</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: system-ui, sans-serif; background: #f5f7fa; min-height: 100vh; }
        .header { background: linear-gradient(135deg, #4f46e5, #7c3aed); color: white; padding: 2rem; text-align: center; }
        .header h1 { font-size: 2rem; margin-bottom: 0.5rem; }
        .header p { opacity: 0.9; }
        .container { max-width: 1200px; margin: 0 auto; padding: 2rem 1rem; }
        .filters { background: white; padding: 1.5rem; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 2rem; display: flex; gap: 1rem; flex-wrap: wrap; align-items: end; }
        .filters label { display: flex; flex-direction: column; gap: 0.25rem; }
        .filters label span { font-size: 0.875rem; color: #666; }
        .filters input, .filters select { padding: 0.5rem; border: 1px solid #ddd; border-radius: 4px; }
        .filters button { padding: 0.5rem 1.5rem; background: #4f46e5; color: white; border: none; border-radius: 4px; cursor: pointer; }
        .filters button:hover { background: #4338ca; }
        .venues { display: grid; grid-template-columns: repeat(auto-fill, minmax(350px, 1fr)); gap: 1.5rem; }
        .venue { background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); overflow: hidden; transition: transform 0.2s, box-shadow 0.2s; }
        .venue:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
        .venue-image { height: 160px; background: linear-gradient(45deg, #e0e7ff, #ddd6fe); display: flex; align-items: center; justify-content: center; color: #6366f1; font-size: 3rem; }
        .venue-content { padding: 1.5rem; }
        .venue h3 { color: #1a1a2e; margin-bottom: 0.5rem; }
        .venue p { color: #666; font-size: 0.875rem; margin-bottom: 1rem; }
        .venue-meta { display: flex; gap: 1rem; margin-bottom: 1rem; font-size: 0.875rem; }
        .venue-meta span { display: flex; align-items: center; gap: 0.25rem; }
        .venue-price { font-size: 1.5rem; font-weight: bold; color: #4f46e5; }
        .venue-price span { font-size: 0.875rem; color: #666; font-weight: normal; }
        .amenities { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1rem; }
        .amenity { background: #f3f4f6; color: #666; padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.75rem; }
        .venue-footer { display: flex; justify-content: space-between; align-items: center; }
        .availability { font-size: 0.875rem; color: #666; }
        .availability.none { color: #dc2626; }
        .btn { padding: 0.5rem 1rem; background: #4f46e5; color: white; text-decoration: none; border-radius: 4px; font-size: 0.875rem; }
        .btn:hover { background: #4338ca; }
        .btn.disabled { background: #d1d5db; pointer-events: none; }
        .badge { background: #10b981; color: white; padding: 0.125rem 0.375rem; border-radius: 3px; font-size: 0.75rem; margin-left: 0.5rem; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>Find Your Perfect Venue</h1>
        <p>Book amazing spaces for your events</p>
      </div>
      <div class="container">
        <form class="filters" method="GET" action="/booking" data-testid="filter-form">
          <label>
            <span>Date</span>
            <input type="date" name="date" value="${date || ''}" data-testid="date-filter">
          </label>
          <label>
            <span>Minimum Capacity</span>
            <input type="number" name="min_capacity" placeholder="Any" value="${min_capacity || ''}" data-testid="capacity-filter">
          </label>
          <label>
            <span>Max Price ($/hr)</span>
            <input type="number" name="max_price" placeholder="Any" value="${max_price || ''}" data-testid="price-filter">
          </label>
          <label>
            <span>Accessibility</span>
            <select name="accessibility" data-testid="accessibility-filter">
              <option value="">Any</option>
              <option value="true" ${accessibility === 'true' ? 'selected' : ''}>Required</option>
            </select>
          </label>
          <button type="submit" data-testid="apply-filters">Apply Filters</button>
        </form>
        <div class="venues">
          ${venuesWithSlots.map(v => `
            <div class="venue" data-testid="venue-${v.id}">
              <div class="venue-image">🏛️</div>
              <div class="venue-content">
                <h3>${v.name}${v.has_accessibility ? '<span class="badge">♿ Accessible</span>' : ''}</h3>
                <p>${v.description}</p>
                <div class="venue-meta">
                  <span>👥 Up to ${v.capacity}</span>
                </div>
                <div class="amenities">
                  ${v.amenities.map((a: string) => `<span class="amenity">${a}</span>`).join('')}
                </div>
                <div class="venue-footer">
                  <div>
                    <div class="venue-price">$${v.price_per_hour}<span>/hour</span></div>
                    <div class="availability ${v.availableSlots === 0 ? 'none' : ''}" data-testid="availability-${v.id}">${v.availableSlots} slots available</div>
                  </div>
                  <a href="/booking/venue/${v.id}${date ? `?date=${date}` : ''}" class="btn ${v.availableSlots === 0 ? 'disabled' : ''}" data-testid="select-venue-${v.id}">Select</a>
                </div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    </body>
    </html>
  `);
});

router.get('/venue/:id', (req: Request, res: Response) => {
  const venue = db.prepare('SELECT * FROM venues WHERE id = ?').get(req.params.id) as Venue | undefined;
  if (!venue) return res.status(404).send('Venue not found');
  
  const { date } = req.query;
  let slots: TimeSlot[];
  if (date) {
    slots = db.prepare('SELECT * FROM time_slots WHERE venue_id = ? AND date = ? AND is_available = 1 ORDER BY date, start_time').all(venue.id, date) as TimeSlot[];
  } else {
    slots = db.prepare('SELECT * FROM time_slots WHERE venue_id = ? AND is_available = 1 ORDER BY date, start_time').all(venue.id) as TimeSlot[];
  }
  
  const slotsByDate = slots.reduce((acc, slot) => {
    if (!acc[slot.date]) acc[slot.date] = [];
    acc[slot.date].push(slot);
    return acc;
  }, {} as Record<string, TimeSlot[]>);
  
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${venue.name} - Booking</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: system-ui, sans-serif; background: #f5f7fa; min-height: 100vh; }
        .header { background: white; border-bottom: 1px solid #e0e0e0; padding: 1rem 2rem; }
        .header a { color: #4f46e5; text-decoration: none; }
        .container { max-width: 800px; margin: 2rem auto; padding: 0 1rem; }
        .venue-hero { background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); padding: 2rem; margin-bottom: 1.5rem; }
        .venue-hero h1 { color: #1a1a2e; margin-bottom: 0.5rem; }
        .venue-hero p { color: #666; margin-bottom: 1rem; }
        .venue-details { display: flex; gap: 2rem; flex-wrap: wrap; }
        .venue-details span { display: flex; align-items: center; gap: 0.25rem; color: #666; }
        .card { background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); padding: 1.5rem; margin-bottom: 1.5rem; }
        h2 { color: #1a1a2e; margin-bottom: 1rem; }
        .date-group { margin-bottom: 1.5rem; }
        .date-group h3 { color: #666; font-size: 0.875rem; margin-bottom: 0.5rem; text-transform: uppercase; }
        .slots { display: flex; gap: 0.5rem; flex-wrap: wrap; }
        .slot { padding: 0.75rem 1rem; border: 2px solid #e0e0e0; border-radius: 6px; cursor: pointer; transition: all 0.2s; }
        .slot:hover { border-color: #4f46e5; background: #f5f3ff; }
        .slot.selected { border-color: #4f46e5; background: #4f46e5; color: white; }
        .slot-time { font-weight: 600; }
        .empty { color: #666; text-align: center; padding: 2rem; }
        form label { display: block; margin-bottom: 1rem; }
        form label span { display: block; font-size: 0.875rem; color: #666; margin-bottom: 0.25rem; }
        input, textarea { width: 100%; padding: 0.75rem; border: 1px solid #ddd; border-radius: 6px; font-size: 1rem; }
        input:focus, textarea:focus { outline: none; border-color: #4f46e5; }
        .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
        button[type="submit"] { width: 100%; padding: 1rem; background: #4f46e5; color: white; border: none; border-radius: 6px; font-size: 1rem; cursor: pointer; margin-top: 1rem; }
        button[type="submit"]:hover { background: #4338ca; }
        button[type="submit"]:disabled { background: #a5b4fc; cursor: not-allowed; }
        .price-summary { background: #f9fafb; border-radius: 6px; padding: 1rem; margin-top: 1rem; }
        .price-row { display: flex; justify-content: space-between; margin-bottom: 0.5rem; }
        .price-row.total { font-weight: bold; font-size: 1.25rem; border-top: 1px solid #e0e0e0; padding-top: 0.5rem; margin-top: 0.5rem; }
      </style>
    </head>
    <body>
      <div class="header">
        <a href="/booking">← Back to venues</a>
      </div>
      <div class="container">
        <div class="venue-hero">
          ${String(req.query.error || '') === 'slot_unavailable' ? '<p data-testid="slot-error" style="color:#b91c1c;font-weight:600;margin-bottom:0.75rem;">That slot just sold out. Pick another time.</p>' : ''}
          <h1>${venue.name}</h1>
          <p>${venue.description}</p>
          <div class="venue-details">
            <span>👥 Up to ${venue.capacity} guests</span>
            <span>💰 $${venue.price_per_hour}/hour</span>
            ${venue.has_accessibility ? '<span>♿ Wheelchair accessible</span>' : ''}
          </div>
        </div>
        
        <div class="card">
          <h2>Select a Time Slot</h2>
          ${Object.keys(slotsByDate).length === 0 ? '<p class="empty">No available slots. Try different dates.</p>' : ''}
          ${Object.entries(slotsByDate).map(([dateKey, dateSlots]) => `
            <div class="date-group">
              <h3>${new Date(dateKey).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</h3>
              <div class="slots">
                ${(dateSlots as TimeSlot[]).map(s => `
                  <label class="slot" data-testid="slot-${s.id}">
                    <input type="radio" name="slot_id" value="${s.id}" style="display:none">
                    <span class="slot-time">${s.start_time} - ${s.end_time}</span>
                  </label>
                `).join('')}
              </div>
            </div>
          `).join('')}
        </div>
        
        <form action="/booking/reserve" method="POST" class="card">
          <h2>Guest Information</h2>
          <input type="hidden" name="venue_id" value="${venue.id}">
          <input type="hidden" name="date" value="${typeof date === 'string' ? date : ''}">
          <input type="hidden" name="selected_slot" id="selected_slot" data-testid="selected-slot-input">
          <div class="form-row">
            <label>
              <span>Full Name</span>
              <input type="text" name="guest_name" required placeholder="John Smith" data-testid="guest-name">
            </label>
            <label>
              <span>Email Address</span>
              <input type="email" name="guest_email" required placeholder="john@example.com" data-testid="guest-email">
            </label>
          </div>
          <label>
            <span>Party Size</span>
            <input type="number" name="party_size" required min="1" max="${venue.capacity}" placeholder="Number of guests" data-testid="party-size">
          </label>
          <label>
            <span>Special Requests (optional)</span>
            <textarea name="special_requests" rows="3" placeholder="Any special requirements..." data-testid="special-requests"></textarea>
          </label>
          <div class="price-summary">
            <div class="price-row"><span>Venue (3 hours)</span><span>$${venue.price_per_hour * 3}</span></div>
            <div class="price-row"><span>Service fee</span><span>$25</span></div>
            <div class="price-row total"><span>Total</span><span data-testid="total-price">$${venue.price_per_hour * 3 + 25}</span></div>
          </div>
          <button type="submit" data-testid="confirm-booking">Confirm Reservation</button>
        </form>
      </div>
      <script>
        document.querySelectorAll('.slot').forEach(slot => {
          slot.addEventListener('click', () => {
            document.querySelectorAll('.slot').forEach(s => s.classList.remove('selected'));
            slot.classList.add('selected');
            slot.querySelector('input').checked = true;
            document.getElementById('selected_slot').value = slot.querySelector('input').value;
          });
        });
      </script>
    </body>
    </html>
  `);
});

router.post('/reserve', (req: Request, res: Response) => {
  const { venue_id, selected_slot, guest_name, guest_email, party_size, special_requests } = req.body;

  if (!selected_slot) {
    return res.status(400).send('Please select a time slot');
  }

  const venue = db.prepare('SELECT * FROM venues WHERE id = ?').get(venue_id) as Venue | undefined;
  if (!venue) return res.status(404).send('Venue not found');

  if (Number(party_size) > venue.capacity) {
    return res.status(400).send('Party size exceeds venue capacity');
  }

  const reservationId = uuid();
  const booked = db.transaction(() => {
    const slot = db.prepare('SELECT * FROM time_slots WHERE id = ? AND is_available = 1').get(selected_slot) as TimeSlot | undefined;
    if (!slot) return false;
    db.prepare('UPDATE time_slots SET is_available = 0 WHERE id = ?').run(selected_slot);
    db.prepare(`
      INSERT INTO reservations (id, slot_id, guest_name, guest_email, party_size, special_requests, confirmed)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(reservationId, selected_slot, guest_name, guest_email, Number(party_size), special_requests || null);
    return true;
  })();

  if (!booked) {
    const qs = new URLSearchParams();
    if (typeof req.body.date === 'string' && req.body.date) qs.set('date', req.body.date);
    qs.set('error', 'slot_unavailable');
    return res.redirect(`/booking/venue/${venue_id}?${qs.toString()}`);
  }

  res.redirect(`/booking/confirmation/${reservationId}`);
});

router.get('/confirmation/:id', (req: Request, res: Response) => {
  const reservation = db.prepare(`
    SELECT r.*, s.date, s.start_time, s.end_time, v.name as venue_name, v.price_per_hour
    FROM reservations r
    JOIN time_slots s ON r.slot_id = s.id
    JOIN venues v ON s.venue_id = v.id
    WHERE r.id = ?
  `).get(req.params.id) as {
    id: string;
    guest_name: string;
    guest_email: string;
    party_size: number;
    special_requests: string | null;
    date: string;
    start_time: string;
    end_time: string;
    venue_name: string;
    price_per_hour: number;
  } | undefined;
  
  if (!reservation) return res.status(404).send('Reservation not found');
  
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Booking Confirmed</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: system-ui, sans-serif; background: #f5f7fa; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        .container { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); width: 100%; max-width: 500px; text-align: center; }
        .checkmark { width: 80px; height: 80px; background: #10b981; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 1rem; }
        .checkmark svg { width: 40px; height: 40px; fill: white; }
        h1 { color: #1a1a2e; margin-bottom: 0.5rem; }
        p { color: #666; margin-bottom: 1rem; }
        .details { background: #f9fafb; border-radius: 8px; padding: 1.5rem; text-align: left; margin: 1.5rem 0; }
        .details dl { display: grid; grid-template-columns: auto 1fr; gap: 0.5rem 1rem; }
        .details dt { color: #666; }
        .details dd { color: #1a1a2e; font-weight: 500; }
        .confirmation-id { font-family: monospace; background: #e0e7ff; color: #4338ca; padding: 0.5rem 1rem; border-radius: 4px; display: inline-block; margin-bottom: 1rem; }
        .btn { display: inline-block; padding: 0.75rem 1.5rem; background: #4f46e5; color: white; text-decoration: none; border-radius: 6px; }
        .btn:hover { background: #4338ca; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="checkmark"><svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></div>
        <h1>Booking Confirmed!</h1>
        <p>Your reservation has been successfully made.</p>
        <div class="confirmation-id" data-testid="confirmation-id">${reservation.id}</div>
        <div class="details">
          <dl>
            <dt>Venue</dt><dd data-testid="conf-venue">${reservation.venue_name}</dd>
            <dt>Date</dt><dd data-testid="conf-date">${new Date(reservation.date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</dd>
            <dt>Time</dt><dd data-testid="conf-time">${reservation.start_time} - ${reservation.end_time}</dd>
            <dt>Guest</dt><dd data-testid="conf-guest">${reservation.guest_name}</dd>
            <dt>Party Size</dt><dd data-testid="conf-party">${reservation.party_size} guests</dd>
            <dt>Total</dt><dd data-testid="conf-total">$${reservation.price_per_hour * 3 + 25}</dd>
          </dl>
        </div>
        <a href="/booking" class="btn">Book Another Venue</a>
      </div>
    </body>
    </html>
  `);
});

router.get('/api/reservation/:id', (req: Request, res: Response) => {
  const reservation = db.prepare(`
    SELECT r.*, s.date, s.start_time, s.end_time, s.venue_id, v.name as venue_name, v.price_per_hour, v.capacity, v.has_accessibility
    FROM reservations r
    JOIN time_slots s ON r.slot_id = s.id
    JOIN venues v ON s.venue_id = v.id
    WHERE r.id = ?
  `).get(req.params.id);
  
  if (!reservation) return res.status(404).json({ error: 'Reservation not found' });
  res.json(reservation);
});

router.get('/api/reservations', (req: Request, res: Response) => {
  const email = typeof req.query.guest_email === 'string' ? req.query.guest_email : undefined;
  const query = `
    SELECT r.id, r.guest_name, r.guest_email, r.party_size, r.special_requests, r.confirmed,
           s.date, s.start_time, s.end_time, s.venue_id,
           v.name AS venue_name, v.price_per_hour, v.capacity, v.has_accessibility
    FROM reservations r
    JOIN time_slots s ON r.slot_id = s.id
    JOIN venues v ON s.venue_id = v.id
    ${email ? 'WHERE r.guest_email = ?' : ''}
    ORDER BY r.created_at ASC
  `;
  const reservations = email
    ? db.prepare(query).all(email)
    : db.prepare(query).all();
  res.json({ count: reservations.length, reservations });
});

router.get('/api/venues', (_req: Request, res: Response) => {
  const venues = db.prepare('SELECT * FROM venues').all() as Venue[];
  res.json(venues.map(v => ({ ...v, amenities: JSON.parse(v.amenities) })));
});

router.get('/api/slots', (req: Request, res: Response) => {
  const { venue_id, date, available_only } = req.query;
  let query = 'SELECT * FROM time_slots WHERE 1=1';
  const params: (string | number)[] = [];
  
  if (venue_id) {
    query += ' AND venue_id = ?';
    params.push(venue_id as string);
  }
  if (date) {
    query += ' AND date = ?';
    params.push(date as string);
  }
  if (available_only === 'true') {
    query += ' AND is_available = 1';
  }
  
  query += ' ORDER BY date, start_time';
  const slots = db.prepare(query).all(...params);
  res.json(slots);
});

router.post('/api/mark-slot-unavailable', (req: Request, res: Response) => {
  const { slot_id } = req.body;
  db.prepare('UPDATE time_slots SET is_available = 0 WHERE id = ?').run(slot_id);
  res.json({ success: true });
});

export default router;
