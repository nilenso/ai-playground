/**
 * Email sending via Mailgun HTTP API.
 *
 * Requires environment variables:
 *   MAILGUN_API_KEY    — Mailgun API key
 *   MAILGUN_DOMAIN     — Sending domain (e.g. mg.example.com)
 */

import { authLogger } from "./logger.ts";

const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY || "";
const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN || "";
const MAILGUN_FROM = `Megasthenes <noreply@${MAILGUN_DOMAIN}>`;

export function isEmailConfigured(): boolean {
	return !!(MAILGUN_API_KEY && MAILGUN_DOMAIN);
}

interface SendEmailParams {
	to: string;
	subject: string;
	text: string;
	html?: string;
}

export async function sendEmail(params: SendEmailParams): Promise<boolean> {
	if (!isEmailConfigured()) {
		authLogger.warn("Mailgun not configured — skipping email to {to}", { to: params.to });
		return false;
	}

	const form = new FormData();
	form.append("from", MAILGUN_FROM);
	form.append("to", params.to);
	form.append("subject", params.subject);
	form.append("text", params.text);
	if (params.html) {
		form.append("html", params.html);
	}

	try {
		const res = await fetch(`https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`, {
			method: "POST",
			headers: {
				Authorization: `Basic ${btoa(`api:${MAILGUN_API_KEY}`)}`,
			},
			body: form,
		});

		if (!res.ok) {
			const body = await res.text();
			authLogger.error("Mailgun send failed: HTTP {status} — {body}", { status: res.status, body });
			return false;
		}

		authLogger.info("Email sent: {subject}", { subject: params.subject });
		return true;
	} catch (err) {
		authLogger.error("Mailgun send error: {error}", {
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Send the "You're approved!" email to a user who was just taken off the waitlist.
 */
export async function sendApprovalEmail(params: { to: string; username: string; appUrl: string }): Promise<boolean> {
	const { to, username, appUrl } = params;
	const safeUsername = escapeHtml(username);
	const safeAppUrl = escapeHtml(appUrl);

	const text = `Hi ${username},

Great news — your Megasthenes account has been approved! You can now sign in and start exploring repositories.

${appUrl}

Happy exploring!
— The Megasthenes team`;

	const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 0;">
  <h2 style="color: #0a2540; margin: 0 0 16px;">You're in! 🎉</h2>
  <p style="color: #425466; font-size: 15px; line-height: 1.6; margin: 0 0 16px;">
    Hi <strong>${safeUsername}</strong>, your Megasthenes account has been approved.
    You can now sign in and start exploring repositories.
  </p>
  <a href="${safeAppUrl}" style="display: inline-block; background: #ec4899; color: #fff; text-decoration: none; padding: 10px 24px; border-radius: 6px; font-weight: 500; font-size: 14px;">
    Open Megasthenes
  </a>
  <p style="color: #8898aa; font-size: 13px; margin: 24px 0 0;">
    Happy exploring!<br/>— The Megasthenes team
  </p>
</div>`.trim();

	return sendEmail({ to, subject: "Your Megasthenes account is approved!", text, html });
}

/**
 * Notify an admin that a new user has joined the waitlist.
 */
export async function sendWaitlistNotificationEmail(params: {
	to: string;
	adminUsername: string;
	newUsername: string;
	appUrl: string;
}): Promise<boolean> {
	const { to, adminUsername, newUsername, appUrl } = params;
	const safeAdmin = escapeHtml(adminUsername);
	const safeNewUser = escapeHtml(newUsername);
	const safeAppUrl = escapeHtml(appUrl);

	const text = `Hi ${adminUsername},

${newUsername} just signed up for Megasthenes and is on the waitlist.

You can approve or disapprove them at ${appUrl}

— Megasthenes`;

	const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 0;">
  <h2 style="color: #0a2540; margin: 0 0 16px;">New waitlist signup</h2>
  <p style="color: #425466; font-size: 15px; line-height: 1.6; margin: 0 0 16px;">
    Hi <strong>${safeAdmin}</strong>, <strong>${safeNewUser}</strong> just signed up for Megasthenes and is waiting for approval.
  </p>
  <a href="${safeAppUrl}" style="display: inline-block; background: #ec4899; color: #fff; text-decoration: none; padding: 10px 24px; border-radius: 6px; font-weight: 500; font-size: 14px;">
    Review waitlist
  </a>
</div>`.trim();

	return sendEmail({ to, subject: `Megasthenes: ${newUsername} is waiting for approval`, text, html });
}
