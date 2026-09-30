import { Router, Request, Response } from 'express';
import { db } from '../db/schema.js';
import { v4 as uuid } from 'uuid';

const router = Router();

interface Ticket {
  id: string;
  subject: string;
  description: string;
  status: string;
  priority: string;
  tags: string;
  assignee: string | null;
  customer_email: string;
  created_at: string;
  updated_at: string;
}

router.get('/', (_req: Request, res: Response) => {
  const tickets = db.prepare('SELECT * FROM tickets ORDER BY created_at DESC').all() as Ticket[];
  
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Support Desk</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: system-ui, sans-serif; background: #f5f7fa; min-height: 100vh; }
        .header { background: white; border-bottom: 1px solid #e0e0e0; padding: 1rem 2rem; display: flex; justify-content: space-between; align-items: center; }
        .header h1 { color: #1a1a2e; font-size: 1.5rem; }
        .container { max-width: 1200px; margin: 2rem auto; padding: 0 1rem; }
        .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 2rem; }
        .stat { background: white; padding: 1rem; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .stat .number { font-size: 2rem; font-weight: bold; color: #4f46e5; }
        .stat .label { color: #666; font-size: 0.875rem; }
        .tickets { background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .ticket-row { display: grid; grid-template-columns: 100px 1fr 100px 100px 120px; gap: 1rem; padding: 1rem; border-bottom: 1px solid #f0f0f0; align-items: center; }
        .ticket-row:hover { background: #f9fafb; }
        .ticket-row:last-child { border-bottom: none; }
        .ticket-header { font-weight: 600; background: #f9fafb; border-radius: 8px 8px 0 0; }
        .ticket-id { font-family: monospace; color: #666; }
        .ticket-subject a { color: #1a1a2e; text-decoration: none; }
        .ticket-subject a:hover { color: #4f46e5; }
        .status { padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.75rem; text-transform: uppercase; font-weight: 600; }
        .status.open { background: #fef3c7; color: #92400e; }
        .status.in-progress { background: #dbeafe; color: #1e40af; }
        .status.resolved { background: #d1fae5; color: #065f46; }
        .status.closed { background: #f3f4f6; color: #6b7280; }
        .priority { padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.75rem; }
        .priority.critical { background: #fee2e2; color: #991b1b; }
        .priority.high { background: #ffedd5; color: #9a3412; }
        .priority.medium { background: #fef3c7; color: #92400e; }
        .priority.low { background: #ecfdf5; color: #065f46; }
        .tags { display: flex; gap: 0.25rem; flex-wrap: wrap; }
        .tag { background: #e0e7ff; color: #4338ca; padding: 0.125rem 0.375rem; border-radius: 3px; font-size: 0.75rem; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>Support Desk</h1>
        <span>Agent Dashboard</span>
      </div>
      <div class="container">
        <div class="stats">
          <div class="stat"><div class="number" data-testid="stat-open">${tickets.filter(t => t.status === 'open').length}</div><div class="label">Open</div></div>
          <div class="stat"><div class="number" data-testid="stat-in-progress">${tickets.filter(t => t.status === 'in-progress').length}</div><div class="label">In Progress</div></div>
          <div class="stat"><div class="number" data-testid="stat-critical">${tickets.filter(t => t.priority === 'critical').length}</div><div class="label">Critical</div></div>
          <div class="stat"><div class="number" data-testid="stat-total">${tickets.length}</div><div class="label">Total</div></div>
        </div>
        <div class="tickets">
          <div class="ticket-row ticket-header">
            <div>ID</div><div>Subject</div><div>Status</div><div>Priority</div><div>Tags</div>
          </div>
          ${tickets.map(t => `
            <div class="ticket-row" data-testid="ticket-row-${t.id}">
              <div class="ticket-id">${t.id}</div>
              <div class="ticket-subject"><a href="/support/ticket/${t.id}" data-testid="ticket-link-${t.id}">${t.subject}</a></div>
              <div><span class="status ${t.status}">${t.status}</span></div>
              <div><span class="priority ${t.priority}">${t.priority}</span></div>
              <div class="tags">${JSON.parse(t.tags).map((tag: string) => `<span class="tag">${tag}</span>`).join('')}</div>
            </div>
          `).join('')}
        </div>
      </div>
    </body>
    </html>
  `);
});

router.get('/ticket/:id', (req: Request, res: Response) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id) as Ticket | undefined;
  if (!ticket) return res.status(404).send('Ticket not found');
  
  const replies = db.prepare('SELECT * FROM ticket_replies WHERE ticket_id = ? ORDER BY created_at ASC').all(ticket.id);
  const tags = JSON.parse(ticket.tags);
  
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${ticket.id} - Support Desk</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: system-ui, sans-serif; background: #f5f7fa; min-height: 100vh; }
        .header { background: white; border-bottom: 1px solid #e0e0e0; padding: 1rem 2rem; }
        .header a { color: #4f46e5; text-decoration: none; }
        .header h1 { color: #1a1a2e; font-size: 1.25rem; margin-top: 0.5rem; }
        .container { max-width: 900px; margin: 2rem auto; padding: 0 1rem; display: grid; grid-template-columns: 2fr 1fr; gap: 1.5rem; }
        .main { display: flex; flex-direction: column; gap: 1rem; }
        .card { background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); padding: 1.5rem; }
        .description { color: #333; line-height: 1.6; }
        .replies { display: flex; flex-direction: column; gap: 1rem; }
        .reply { border-left: 3px solid #4f46e5; padding-left: 1rem; }
        .reply.internal { border-color: #f59e0b; background: #fffbeb; padding: 1rem; border-radius: 4px; }
        .reply-meta { font-size: 0.875rem; color: #666; margin-bottom: 0.5rem; }
        h2 { margin-bottom: 1rem; color: #1a1a2e; }
        h3 { margin-bottom: 0.5rem; color: #333; font-size: 1rem; }
        .sidebar label { display: block; margin-bottom: 1rem; }
        .sidebar label span { display: block; font-size: 0.875rem; color: #666; margin-bottom: 0.25rem; }
        select, input, textarea { width: 100%; padding: 0.5rem; border: 1px solid #ddd; border-radius: 4px; font-size: 0.875rem; }
        .tags-input { display: flex; flex-wrap: wrap; gap: 0.25rem; margin-bottom: 0.5rem; }
        .tag { background: #e0e7ff; color: #4338ca; padding: 0.25rem 0.5rem; border-radius: 3px; font-size: 0.75rem; display: flex; align-items: center; gap: 0.25rem; }
        .tag button { background: none; border: none; cursor: pointer; color: #4338ca; }
        button[type="submit"] { background: #4f46e5; color: white; border: none; padding: 0.75rem 1rem; border-radius: 4px; cursor: pointer; width: 100%; margin-top: 0.5rem; }
        button[type="submit"]:hover { background: #4338ca; }
        .reply-form textarea { min-height: 100px; }
        .checkbox-row { display: flex; align-items: center; gap: 0.5rem; margin: 0.5rem 0; }
        .checkbox-row input { width: auto; }
      </style>
    </head>
    <body>
      <div class="header">
        <a href="/support">← Back to tickets</a>
        <h1><span class="ticket-id">${ticket.id}</span> - ${ticket.subject}</h1>
      </div>
      <div class="container">
        <div class="main">
          <div class="card">
            <h2>Description</h2>
            <p class="description" data-testid="ticket-description">${ticket.description}</p>
            <p style="margin-top: 1rem; font-size: 0.875rem; color: #666;">From: ${ticket.customer_email}</p>
          </div>
          <div class="card">
            <h2>Replies</h2>
            <div class="replies" data-testid="replies-container">
              ${replies.length === 0 ? '<p style="color: #666;">No replies yet.</p>' : ''}
              ${(replies as Array<{ id: string; author: string; content: string; is_internal: boolean; created_at: string }>).map(r => `
                <div class="reply ${r.is_internal ? 'internal' : ''}" data-testid="reply-${r.id}">
                  <div class="reply-meta">${r.author} • ${r.created_at}${r.is_internal ? ' • Internal note' : ''}</div>
                  <p>${r.content}</p>
                </div>
              `).join('')}
            </div>
          </div>
          <div class="card">
            <h2>Add Reply</h2>
            <form action="/support/ticket/${ticket.id}/reply" method="POST">
              <textarea name="content" placeholder="Write your reply..." required data-testid="reply-input"></textarea>
              <div class="checkbox-row">
                <input type="checkbox" name="is_internal" id="is_internal" data-testid="internal-checkbox">
                <label for="is_internal">Internal note (not visible to customer)</label>
              </div>
              <label><span>Author</span><input type="text" name="author" value="Support Agent" data-testid="author-input"></label>
              <button type="submit" data-testid="submit-reply">Send Reply</button>
            </form>
          </div>
        </div>
        <div class="sidebar">
          <div class="card">
            <h3>Update Ticket</h3>
            <form action="/support/ticket/${ticket.id}/update" method="POST">
              <label>
                <span>Status</span>
                <select name="status" data-testid="status-select">
                  <option value="open" ${ticket.status === 'open' ? 'selected' : ''}>Open</option>
                  <option value="in-progress" ${ticket.status === 'in-progress' ? 'selected' : ''}>In Progress</option>
                  <option value="resolved" ${ticket.status === 'resolved' ? 'selected' : ''}>Resolved</option>
                  <option value="closed" ${ticket.status === 'closed' ? 'selected' : ''}>Closed</option>
                </select>
              </label>
              <label>
                <span>Priority</span>
                <select name="priority" data-testid="priority-select">
                  <option value="low" ${ticket.priority === 'low' ? 'selected' : ''}>Low</option>
                  <option value="medium" ${ticket.priority === 'medium' ? 'selected' : ''}>Medium</option>
                  <option value="high" ${ticket.priority === 'high' ? 'selected' : ''}>High</option>
                  <option value="critical" ${ticket.priority === 'critical' ? 'selected' : ''}>Critical</option>
                </select>
              </label>
              <label>
                <span>Assignee</span>
                <select name="assignee" data-testid="assignee-select">
                  <option value="">Unassigned</option>
                  <option value="support-team" ${ticket.assignee === 'support-team' ? 'selected' : ''}>Support Team</option>
                  <option value="dev-team" ${ticket.assignee === 'dev-team' ? 'selected' : ''}>Dev Team</option>
                  <option value="billing-team" ${ticket.assignee === 'billing-team' ? 'selected' : ''}>Billing Team</option>
                  <option value="security-team" ${ticket.assignee === 'security-team' ? 'selected' : ''}>Security Team</option>
                </select>
              </label>
              <label>
                <span>Tags (comma-separated)</span>
                <input type="text" name="tags" value="${tags.join(', ')}" data-testid="tags-input">
              </label>
              <button type="submit" data-testid="update-ticket">Update Ticket</button>
            </form>
          </div>
        </div>
      </div>
    </body>
    </html>
  `);
});

router.post('/ticket/:id/update', (req: Request, res: Response) => {
  const { status, priority, assignee, tags } = req.body;
  const tagsArray = tags.split(',').map((t: string) => t.trim()).filter(Boolean);
  
  db.prepare(`
    UPDATE tickets 
    SET status = ?, priority = ?, assignee = ?, tags = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(status, priority, assignee || null, JSON.stringify(tagsArray), req.params.id);
  
  res.redirect(`/support/ticket/${req.params.id}`);
});

router.post('/ticket/:id/reply', (req: Request, res: Response) => {
  const { content, author, is_internal } = req.body;
  const replyId = uuid();
  
  db.prepare(`
    INSERT INTO ticket_replies (id, ticket_id, author, content, is_internal)
    VALUES (?, ?, ?, ?, ?)
  `).run(replyId, req.params.id, author || 'Support Agent', content, is_internal === 'on' ? 1 : 0);
  
  db.prepare('UPDATE tickets SET updated_at = datetime(\'now\') WHERE id = ?').run(req.params.id);
  
  res.redirect(`/support/ticket/${req.params.id}`);
});

router.get('/api/ticket/:id', (req: Request, res: Response) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id) as Ticket | undefined;
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  
  const replies = db.prepare('SELECT * FROM ticket_replies WHERE ticket_id = ? ORDER BY created_at ASC').all(ticket.id);
  
  res.json({
    ...ticket,
    tags: JSON.parse(ticket.tags),
    replies,
  });
});

router.get('/api/tickets', (_req: Request, res: Response) => {
  const tickets = db.prepare('SELECT * FROM tickets ORDER BY created_at DESC').all() as Ticket[];
  res.json(tickets.map(t => ({ ...t, tags: JSON.parse(t.tags) })));
});

export default router;
