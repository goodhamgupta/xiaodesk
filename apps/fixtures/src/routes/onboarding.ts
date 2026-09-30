import { Router, Request, Response } from 'express';
import { db } from '../db/schema.js';
import { v4 as uuid } from 'uuid';
import PDFDocument from 'pdfkit';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Acme Onboarding</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: system-ui, sans-serif; background: #f5f7fa; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        .container { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); width: 100%; max-width: 480px; }
        h1 { color: #1a1a2e; margin-bottom: 0.5rem; }
        p.subtitle { color: #666; margin-bottom: 1.5rem; }
        .steps { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; }
        .step { flex: 1; height: 4px; background: #e0e0e0; border-radius: 2px; }
        .step.active { background: #4f46e5; }
        .step.done { background: #10b981; }
        form { display: flex; flex-direction: column; gap: 1rem; }
        label { font-weight: 500; color: #333; }
        input, select { padding: 0.75rem; border: 1px solid #ddd; border-radius: 6px; font-size: 1rem; }
        input:focus, select:focus { outline: none; border-color: #4f46e5; }
        button { padding: 0.875rem; background: #4f46e5; color: white; border: none; border-radius: 6px; font-size: 1rem; cursor: pointer; transition: background 0.2s; }
        button:hover { background: #4338ca; }
        .error { color: #dc2626; background: #fef2f2; padding: 0.75rem; border-radius: 6px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="steps"><div class="step active"></div><div class="step"></div><div class="step"></div><div class="step"></div></div>
        <h1>Create Your Account</h1>
        <p class="subtitle">Step 1 of 4: Enter your details</p>
        <form action="/onboarding/signup" method="POST">
          <label>Full Name<input type="text" name="name" required placeholder="John Smith" data-testid="name-input"></label>
          <label>Email Address<input type="email" name="email" required placeholder="john@example.com" data-testid="email-input"></label>
          <button type="submit" data-testid="continue-btn">Continue</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

router.post('/signup', (req: Request, res: Response) => {
  const { name, email } = req.body;
  
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    return res.status(400).send('Email already registered');
  }
  
  const userId = uuid();
  const sessionId = uuid();
  const token = uuid();
  
  db.prepare('INSERT INTO users (id, email, name) VALUES (?, ?, ?)').run(userId, email, name);
  db.prepare('INSERT INTO sessions (id, user_id, token) VALUES (?, ?, ?)').run(sessionId, userId, token);
  
  res.cookie('session_token', token, { httpOnly: true, maxAge: 86400000 });
  res.redirect('/onboarding/plan');
});

router.get('/plan', (req: Request, res: Response) => {
  const token = req.cookies.session_token;
  if (!token) return res.redirect('/onboarding');
  
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Choose Your Plan - Acme</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: system-ui, sans-serif; background: #f5f7fa; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        .container { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); width: 100%; max-width: 680px; }
        h1 { color: #1a1a2e; margin-bottom: 0.5rem; }
        p.subtitle { color: #666; margin-bottom: 1.5rem; }
        .steps { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; }
        .step { flex: 1; height: 4px; background: #e0e0e0; border-radius: 2px; }
        .step.active { background: #4f46e5; }
        .step.done { background: #10b981; }
        .plans { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }
        .plan { border: 2px solid #e0e0e0; border-radius: 8px; padding: 1.5rem; text-align: center; cursor: pointer; transition: all 0.2s; }
        .plan:hover { border-color: #4f46e5; }
        .plan.selected { border-color: #4f46e5; background: #f5f3ff; }
        .plan h3 { margin-bottom: 0.5rem; }
        .plan .price { font-size: 2rem; font-weight: bold; color: #4f46e5; }
        .plan .price span { font-size: 1rem; color: #666; }
        .plan ul { list-style: none; margin: 1rem 0; text-align: left; }
        .plan li { padding: 0.25rem 0; color: #666; }
        .plan li::before { content: "✓ "; color: #10b981; }
        button { padding: 0.875rem 2rem; background: #4f46e5; color: white; border: none; border-radius: 6px; font-size: 1rem; cursor: pointer; margin-top: 1.5rem; }
        button:hover { background: #4338ca; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="steps"><div class="step done"></div><div class="step active"></div><div class="step"></div><div class="step"></div></div>
        <h1>Choose Your Plan</h1>
        <p class="subtitle">Step 2 of 4: Select the plan that works for you</p>
        <form action="/onboarding/plan" method="POST">
          <div class="plans">
            <label class="plan">
              <input type="radio" name="plan" value="free" style="display:none" data-testid="plan-free">
              <h3>Free</h3>
              <div class="price">$0<span>/mo</span></div>
              <ul><li>5 projects</li><li>1GB storage</li><li>Community support</li></ul>
            </label>
            <label class="plan">
              <input type="radio" name="plan" value="pro" style="display:none" data-testid="plan-pro">
              <h3>Pro</h3>
              <div class="price">$19<span>/mo</span></div>
              <ul><li>Unlimited projects</li><li>50GB storage</li><li>Email support</li></ul>
            </label>
            <label class="plan">
              <input type="radio" name="plan" value="enterprise" style="display:none" data-testid="plan-enterprise">
              <h3>Enterprise</h3>
              <div class="price">$99<span>/mo</span></div>
              <ul><li>Everything in Pro</li><li>500GB storage</li><li>Priority support</li></ul>
            </label>
          </div>
          <button type="submit" data-testid="continue-btn">Continue</button>
        </form>
      </div>
      <script>
        document.querySelectorAll('.plan').forEach(p => {
          p.addEventListener('click', () => {
            document.querySelectorAll('.plan').forEach(x => x.classList.remove('selected'));
            p.classList.add('selected');
            p.querySelector('input').checked = true;
          });
        });
      </script>
    </body>
    </html>
  `);
});

router.post('/plan', (req: Request, res: Response) => {
  const token = req.cookies.session_token;
  if (!token) return res.redirect('/onboarding');
  
  const { plan } = req.body;
  const session = db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token) as { user_id: string } | undefined;
  if (!session) return res.redirect('/onboarding');
  
  db.prepare('UPDATE users SET plan = ? WHERE id = ?').run(plan || 'free', session.user_id);
  res.redirect('/onboarding/terms');
});

router.get('/terms', (req: Request, res: Response) => {
  const token = req.cookies.session_token;
  if (!token) return res.redirect('/onboarding');
  
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Terms of Service - Acme</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: system-ui, sans-serif; background: #f5f7fa; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        .container { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); width: 100%; max-width: 580px; }
        h1 { color: #1a1a2e; margin-bottom: 0.5rem; }
        p.subtitle { color: #666; margin-bottom: 1.5rem; }
        .steps { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; }
        .step { flex: 1; height: 4px; background: #e0e0e0; border-radius: 2px; }
        .step.active { background: #4f46e5; }
        .step.done { background: #10b981; }
        .terms-box { background: #f9fafb; border: 1px solid #e0e0e0; border-radius: 6px; padding: 1rem; height: 200px; overflow-y: auto; margin-bottom: 1rem; font-size: 0.875rem; color: #666; line-height: 1.6; }
        .checkbox-row { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; }
        .checkbox-row input { width: 18px; height: 18px; }
        button { padding: 0.875rem 2rem; background: #4f46e5; color: white; border: none; border-radius: 6px; font-size: 1rem; cursor: pointer; width: 100%; }
        button:hover { background: #4338ca; }
        button:disabled { background: #a5b4fc; cursor: not-allowed; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="steps"><div class="step done"></div><div class="step done"></div><div class="step active"></div><div class="step"></div></div>
        <h1>Terms of Service</h1>
        <p class="subtitle">Step 3 of 4: Review and accept our terms</p>
        <div class="terms-box" data-testid="terms-content">
          <h4>Acme Terms of Service</h4>
          <p>Last updated: March 2024</p>
          <p>By using Acme's services, you agree to the following terms and conditions:</p>
          <p><strong>1. Use of Service</strong><br>You may use Acme for lawful purposes only. You agree not to use the service for any illegal or unauthorized purpose.</p>
          <p><strong>2. Account Security</strong><br>You are responsible for maintaining the security of your account and password.</p>
          <p><strong>3. Data Privacy</strong><br>We respect your privacy. Your data will be handled in accordance with our Privacy Policy.</p>
          <p><strong>4. Termination</strong><br>We may terminate or suspend your account at any time for violations of these terms.</p>
          <p><strong>5. Limitation of Liability</strong><br>Acme is provided "as is" without warranties of any kind.</p>
        </div>
        <form action="/onboarding/terms" method="POST">
          <div class="checkbox-row">
            <input type="checkbox" id="accept" name="accept" required data-testid="accept-checkbox">
            <label for="accept">I have read and accept the Terms of Service</label>
          </div>
          <button type="submit" data-testid="continue-btn">Accept and Continue</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

router.post('/terms', (req: Request, res: Response) => {
  const token = req.cookies.session_token;
  if (!token) return res.redirect('/onboarding');
  
  const session = db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token) as { user_id: string } | undefined;
  if (!session) return res.redirect('/onboarding');
  
  db.prepare('UPDATE users SET terms_accepted_at = datetime(\'now\') WHERE id = ?').run(session.user_id);
  res.redirect('/onboarding/welcome');
});

router.get('/welcome', (req: Request, res: Response) => {
  const token = req.cookies.session_token;
  if (!token) return res.redirect('/onboarding');
  
  const session = db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token) as { user_id: string } | undefined;
  if (!session) return res.redirect('/onboarding');
  
  const user = db.prepare('SELECT name, email, plan FROM users WHERE id = ?').get(session.user_id) as { name: string; email: string; plan: string };
  
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Welcome - Acme</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: system-ui, sans-serif; background: #f5f7fa; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        .container { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); width: 100%; max-width: 480px; text-align: center; }
        .steps { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; }
        .step { flex: 1; height: 4px; background: #10b981; border-radius: 2px; }
        .checkmark { width: 80px; height: 80px; background: #10b981; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 1rem; }
        .checkmark svg { width: 40px; height: 40px; fill: white; }
        h1 { color: #1a1a2e; margin-bottom: 0.5rem; }
        p { color: #666; margin-bottom: 1rem; }
        .info { background: #f9fafb; border-radius: 6px; padding: 1rem; margin: 1rem 0; text-align: left; }
        .info dt { font-weight: 600; color: #333; }
        .info dd { color: #666; margin-bottom: 0.5rem; }
        .btn { display: inline-block; padding: 0.875rem 2rem; background: #4f46e5; color: white; text-decoration: none; border-radius: 6px; margin-top: 1rem; }
        .btn:hover { background: #4338ca; }
        .btn.secondary { background: white; color: #4f46e5; border: 1px solid #4f46e5; margin-left: 0.5rem; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="steps"><div class="step"></div><div class="step"></div><div class="step"></div><div class="step"></div></div>
        <div class="checkmark"><svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></div>
        <h1>Welcome to Acme, ${user.name}!</h1>
        <p>Your account has been successfully created.</p>
        <dl class="info">
          <dt>Email</dt><dd data-testid="user-email">${user.email}</dd>
          <dt>Plan</dt><dd data-testid="user-plan">${user.plan.charAt(0).toUpperCase() + user.plan.slice(1)}</dd>
        </dl>
        <a href="/onboarding/download-welcome" class="btn" data-testid="download-btn">Download Welcome Guide (PDF)</a>
        <a href="/onboarding/dashboard" class="btn secondary" data-testid="dashboard-btn">Go to Dashboard</a>
      </div>
    </body>
    </html>
  `);
});

router.get('/download-welcome', (req: Request, res: Response) => {
  const token = req.cookies.session_token;
  if (!token) return res.redirect('/onboarding');
  
  const session = db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token) as { user_id: string } | undefined;
  if (!session) return res.redirect('/onboarding');
  
  const user = db.prepare('SELECT name, email, plan FROM users WHERE id = ?').get(session.user_id) as { name: string; email: string; plan: string };
  
  const downloadId = uuid();
  db.prepare('INSERT INTO welcome_downloads (id, user_id, filename) VALUES (?, ?, ?)').run(downloadId, session.user_id, 'welcome-guide.pdf');
  
  const doc = new PDFDocument();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="welcome-guide.pdf"');
  
  doc.pipe(res);
  doc.fontSize(24).text('Welcome to Acme!', { align: 'center' });
  doc.moveDown();
  doc.fontSize(14).text(`Hello ${user.name},`);
  doc.moveDown();
  doc.text('Thank you for joining Acme. This guide will help you get started.');
  doc.moveDown();
  doc.text(`Your plan: ${user.plan.charAt(0).toUpperCase() + user.plan.slice(1)}`);
  doc.moveDown();
  doc.text('Getting Started:');
  doc.list(['Explore your dashboard', 'Create your first project', 'Invite team members', 'Check out our documentation']);
  doc.end();
});

router.get('/dashboard', (req: Request, res: Response) => {
  const token = req.cookies.session_token;
  if (!token) return res.redirect('/onboarding');
  
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Dashboard - Acme</title>
      <style>
        body { font-family: system-ui, sans-serif; padding: 2rem; background: #f5f7fa; }
        h1 { color: #1a1a2e; }
        p { color: #666; }
      </style>
    </head>
    <body>
      <h1>Dashboard</h1>
      <p data-testid="dashboard-message">Welcome to your Acme dashboard. Your account is all set up!</p>
    </body>
    </html>
  `);
});

router.get('/api/user', (req: Request, res: Response) => {
  const token = req.cookies.session_token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  
  const session = db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token) as { user_id: string } | undefined;
  if (!session) return res.status(401).json({ error: 'Invalid session' });
  
  const user = db.prepare('SELECT id, name, email, plan, terms_accepted_at, created_at FROM users WHERE id = ?').get(session.user_id);
  const downloads = db.prepare('SELECT * FROM welcome_downloads WHERE user_id = ?').all(session.user_id);
  
  res.json({ user, downloads, session_token: token });
});

export default router;
