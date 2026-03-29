import { Hono } from 'hono';
import { html } from 'hono/html';
import { Database } from 'bun:sqlite';
import { listUsers } from '../db/users.js';
import { getLeaveRecordsByStatus } from '../plugins/leave/leave-records.js';

export function createWebServer(db: Database) {
  const app = new Hono();

  // Basic HTML layout wrapper
  const Layout = (props: { title: string; children: any }) => html`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${props.title} - Jadoo Admin</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding: 2rem; background: #f9fafb; color: #333; }
          .container { max-width: 1000px; margin: 0 auto; background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
          h1 { border-bottom: 2px solid #eee; padding-bottom: 0.5rem; }
          nav { margin-bottom: 2rem; }
          nav a { margin-right: 1rem; text-decoration: none; color: #0066cc; font-weight: bold; }
          nav a:hover { text-decoration: underline; }
          table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
          th, td { text-align: left; padding: 12px; border-bottom: 1px solid #ddd; }
          th { background-color: #f1f5f9; }
        </style>
      </head>
      <body>
        <div class="container">
          <nav>
            <a href="/">Dashboard</a>
            <a href="/users">Users</a>
            <a href="/leaves">Leave History</a>
            <a href="/health">Health</a>
          </nav>
          ${props.children}
        </div>
      </body>
    </html>
  `;

  app.get('/', (c) => {
    return c.html(
      Layout({
        title: 'Dashboard',
        children: html`
          <h1>Dashboard</h1>
          <p>Welcome to the Jadoo Admin Dashboard.</p>
          <div style="display: flex; gap: 2rem; margin-top: 2rem;">
            <div style="flex: 1; padding: 1.5rem; background: #e0f2fe; border-radius: 8px;">
              <h3>Quick Links</h3>
              <ul>
                <li><a href="/users">Manage Users</a></li>
                <li><a href="/leaves">View Leave Records</a></li>
              </ul>
            </div>
          </div>
        `,
      })
    );
  });

  app.get('/users', (c) => {
    const users = listUsers(db);
    return c.html(
      Layout({
        title: 'Users',
        children: html`
          <h1>Users Management</h1>
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Slack Name</th>
                <th>Email</th>
                <th>Timezone</th>
                <th>Harvest ID</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${users.map(
                (u) => html`
                <tr>
                  <td>${u.id}</td>
                  <td>${u.slack_display_name}</td>
                  <td>${u.email || '-'}</td>
                  <td>${u.slack_timezone}</td>
                  <td>${u.harvest_user_id || 'Not mapped'}</td>
                  <td>${u.is_active ? '✅ Active' : '❌ Inactive'}</td>
                </tr>
              `
              )}
            </tbody>
          </table>
        `,
      })
    );
  });

  app.get('/leaves', (c) => {
    // Load recently completed leave records for the history view
    const records = getLeaveRecordsByStatus(db, 'completed');
    return c.html(
      Layout({
        title: 'Leave History',
        children: html`
          <h1>Leave History</h1>
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>User ID</th>
                <th>Date</th>
                <th>Type</th>
                <th>Category</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${records.map(
                (r) => html`
                <tr>
                  <td>${r.id}</td>
                  <td>${r.user_id}</td>
                  <td>${r.date}</td>
                  <td>${r.leave_type}</td>
                  <td>${r.leave_category}</td>
                  <td><span style="color: green;">${r.status}</span></td>
                </tr>
              `
              )}
            </tbody>
          </table>
        `,
      })
    );
  });

  app.get('/health', (c) => {
      return c.json({
          status: 'ok',
          uptime: process.uptime(),
          version: '0.1.0'
      });
  });

  return app;
}
