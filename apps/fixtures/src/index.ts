import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { initSchema, resetDatabase, db } from './db/schema.js';
import { seedAll } from './seed/index.js';
import onboardingRoutes from './routes/onboarding.js';
import supportRoutes from './routes/support.js';
import bookingRoutes from './routes/booking.js';

const app = express();
const PORT = process.env.FIXTURES_PORT || 4317;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use('/onboarding', onboardingRoutes);
app.use('/support', supportRoutes);
app.use('/booking', bookingRoutes);

app.get('/', (_req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>MicroVM Workshop - Fixture Apps</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: system-ui, sans-serif; background: linear-gradient(135deg, #1a1a2e, #16213e); min-height: 100vh; color: white; padding: 2rem; }
        .container { max-width: 800px; margin: 0 auto; }
        h1 { font-size: 2.5rem; margin-bottom: 0.5rem; }
        .subtitle { color: #a0aec0; margin-bottom: 2rem; }
        .apps { display: grid; gap: 1.5rem; }
        .app { background: rgba(255,255,255,0.1); border-radius: 12px; padding: 1.5rem; backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.1); transition: transform 0.2s, border-color 0.2s; }
        .app:hover { transform: translateY(-2px); border-color: rgba(255,255,255,0.3); }
        .app h2 { margin-bottom: 0.5rem; }
        .app p { color: #a0aec0; margin-bottom: 1rem; font-size: 0.9rem; }
        .app a { display: inline-block; padding: 0.5rem 1rem; background: #4f46e5; color: white; text-decoration: none; border-radius: 6px; font-size: 0.875rem; }
        .app a:hover { background: #4338ca; }
        .api-section { margin-top: 2rem; background: rgba(255,255,255,0.05); border-radius: 8px; padding: 1rem; }
        .api-section h3 { margin-bottom: 0.5rem; font-size: 1rem; }
        .api-section code { background: rgba(0,0,0,0.3); padding: 0.125rem 0.375rem; border-radius: 3px; font-size: 0.875rem; }
        .reset-btn { margin-top: 1.5rem; padding: 0.5rem 1rem; background: #dc2626; color: white; border: none; border-radius: 6px; cursor: pointer; }
        .reset-btn:hover { background: #b91c1c; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🖥️ MicroVM Workshop</h1>
        <p class="subtitle">Fixture web apps for browser-use training tasks</p>
        
        <div class="apps">
          <div class="app">
            <h2>📋 Onboarding Portal</h2>
            <p>Multi-step signup flow: registration → plan selection → terms acceptance → welcome page with PDF download</p>
            <a href="/onboarding">Launch App</a>
          </div>
          
          <div class="app">
            <h2>🎫 Support Desk</h2>
            <p>Ticket management system: view tickets, update status/priority/tags, assign to teams, add replies</p>
            <a href="/support">Launch App</a>
          </div>
          
          <div class="app">
            <h2>📅 Booking App</h2>
            <p>Venue reservation system: search/filter venues, select time slots, complete booking with constraints</p>
            <a href="/booking">Launch App</a>
          </div>
        </div>
        
        <div class="api-section">
          <h3>API Endpoints</h3>
          <p style="color: #a0aec0; font-size: 0.875rem; margin-bottom: 0.5rem;">For programmatic verification:</p>
          <ul style="color: #a0aec0; font-size: 0.875rem; list-style: none;">
            <li><code>GET /onboarding/api/user</code> - Get current user (requires session cookie)</li>
            <li><code>GET /support/api/tickets</code> - List all tickets</li>
            <li><code>GET /support/api/ticket/:id</code> - Get ticket details</li>
            <li><code>GET /booking/api/venues</code> - List all venues</li>
            <li><code>GET /booking/api/slots</code> - List time slots (filter: venue_id, date, available_only)</li>
            <li><code>GET /booking/api/reservation/:id</code> - Get reservation details</li>
            <li><code>POST /api/reset</code> - Reset database and reseed</li>
          </ul>
        </div>
        
        <form action="/api/reset" method="POST" style="display: inline;">
          <button type="submit" class="reset-btn">🔄 Reset All Data</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

app.post('/api/reset', (_req, res) => {
  try {
    resetDatabase();
    seedAll();
    res.json({ success: true, message: 'Database reset and reseeded' });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

function ensureSeeded() {
  const count = db.prepare('SELECT COUNT(*) as count FROM venues').get() as { count: number };
  if (count.count === 0) {
    console.log('Database empty, seeding initial data...');
    seedAll();
  }
}

ensureSeeded();

app.listen(PORT, () => {
  console.log(`\n🚀 Fixture apps running at http://localhost:${PORT}`);
  console.log(`   📋 Onboarding: http://localhost:${PORT}/onboarding`);
  console.log(`   🎫 Support:    http://localhost:${PORT}/support`);
  console.log(`   📅 Booking:    http://localhost:${PORT}/booking`);
  console.log(`   🔄 Reset:      POST http://localhost:${PORT}/api/reset\n`);
});

export { app };
