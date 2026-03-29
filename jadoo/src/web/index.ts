import { Hono } from 'hono';
import { html } from 'hono/html';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Database } from 'bun:sqlite';
import { listUsers } from '../db/users.js';
import { getLeaveRecordsByStatus } from '../plugins/leave/leave-records.js';

export interface WebConfig {
  port?: number;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  sessionSecret?: string;
  adminEmails?: string[];
}

export function createWebServer(db: Database, config?: WebConfig) {
  const app = new Hono();

  const clientId = config?.clientId;
  const clientSecret = config?.clientSecret;
  const redirectUri = config?.redirectUri;
  const adminEmails = config?.adminEmails || [];

  // Minimal "session" state via signed/encrypted cookie (or just plain for this demo)
  const SESSION_COOKIE = 'jadoo_admin_session';

  // Basic HTML layout wrapper
  const Layout = (props: { title: string; children: any; user?: string }) => html`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${props.title} - Jadoo Admin</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding: 2rem; background: #f9fafb; color: #333; margin: 0; }
          .container { max-width: 1000px; margin: 0 auto; background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
          .header-bar { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid #eee; padding-bottom: 0.5rem; margin-bottom: 2rem; }
          h1 { margin: 0; }
          nav a { margin-right: 1rem; text-decoration: none; color: #0066cc; font-weight: bold; }
          nav a:hover { text-decoration: underline; }
          table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
          th, td { text-align: left; padding: 12px; border-bottom: 1px solid #ddd; }
          th { background-color: #f1f5f9; }
          .logout { color: #dc2626; font-size: 0.875rem; text-decoration: none; }
          .logout:hover { text-decoration: underline; }
          .google-btn { display: inline-block; background: #4285F4; color: white; padding: 10px 24px; text-decoration: none; font-weight: bold; border-radius: 4px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header-bar">
            <div>
              <h1>Jadoo Admin</h1>
              ${props.user ? html`
                <nav style="margin-top: 1rem;">
                  <a href="/">Dashboard</a>
                  <a href="/users">Users</a>
                  <a href="/leaves">Leave History</a>
                  <a href="/health">Health</a>
                </nav>
              ` : ''}
            </div>
            ${props.user ? html`<div><span>${props.user}</span> | <a href="/logout" class="logout">Logout</a></div>` : ''}
          </div>
          ${props.children}
        </div>
      </body>
    </html>
  `;

  // Middleware: Check authentication
  app.use('*', async (c, next) => {
    // Skip auth for login, callback, and health
    if (c.req.path === '/login' || c.req.path === '/auth/google/callback' || c.req.path === '/health') {
      return next();
    }

    // If OAuth is not configured, we just bypass auth entirely (dev mode)
    if (!clientId || !clientSecret) {
      c.set('user', 'dev@local');
      return next();
    }

    const session = getCookie(c, SESSION_COOKIE);
    if (!session || !adminEmails.includes(session)) {
      return c.redirect('/login');
    }

    c.set('user', session);
    await next();
  });

  // Login page
  app.get('/login', (c) => {
    if (!clientId) {
      return c.html(
        Layout({
          title: 'Login',
          children: html`
            <h2>OAuth not configured</h2>
            <p>Jadoo is running in dev mode. Auth is bypassed.</p>
            <a href="/">Go to Dashboard</a>
          `,
        })
      );
    }

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=email profile`;
    return c.html(
      Layout({
        title: 'Login',
        children: html`
          <div style="text-align: center; padding: 4rem 0;">
            <h2>Admin Login</h2>
            <p style="margin-bottom: 2rem;">Please sign in with an authorized Google Workspace account.</p>
            <a href="${authUrl}" class="google-btn">Sign in with Google</a>
          </div>
        `,
      })
    );
  });

  // OAuth Callback
  app.get('/auth/google/callback', async (c) => {
    const code = c.req.query('code');
    if (!code) return c.text('Missing authorization code', 400);

    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId!,
          client_secret: clientSecret!,
          redirect_uri: redirectUri!,
          grant_type: 'authorization_code',
        }),
      });

      const tokenData = (await tokenRes.json()) as any;
      if (!tokenData.access_token) throw new Error('Failed to get access token');

      const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });

      const userData = (await userRes.json()) as { email: string };
      const email = userData.email;

      if (!adminEmails.includes(email)) {
        return c.html(
          Layout({
            title: 'Unauthorized',
            children: html`
              <div style="text-align: center; color: #dc2626;">
                <h2>Unauthorized</h2>
                <p>The email <b>${email}</b> is not authorized to access this dashboard.</p>
                <a href="/login">Try again</a>
              </div>
            `,
          })
        );
      }

      setCookie(c, SESSION_COOKIE, email, { path: '/', httpOnly: true, secure: true, sameSite: 'Lax' });
      return c.redirect('/');
    } catch (e) {
      console.error('OAuth Error:', e);
      return c.text('Authentication failed', 500);
    }
  });

  app.get('/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE);
    return c.redirect('/login');
  });

  app.get('/', (c) => {
    const user = c.get('user') as string;
    return c.html(
      Layout({
        title: 'Dashboard',
        user,
        children: html`
          <h2>Dashboard</h2>
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
    const user = c.get('user') as string;
    const users = listUsers(db);
    return c.html(
      Layout({
        title: 'Users',
        user,
        children: html`
          <h2>Users Management</h2>
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
    const user = c.get('user') as string;
    const records = getLeaveRecordsByStatus(db, 'completed');
    return c.html(
      Layout({
        title: 'Leave History',
        user,
        children: html`
          <h2>Leave History</h2>
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
