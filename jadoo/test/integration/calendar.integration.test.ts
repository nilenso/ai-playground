/**
 * Integration tests for GCalService against the real Google Calendar API.
 *
 * Requires: GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY, GOOGLE_CALENDAR_ID
 *
 * These tests create real calendar events and clean them up afterwards.
 */

import { GCalService } from "../../src/services/calendar/gcal-service.js";
import { describeIntegration, expect, it } from "./helpers.js";

const REQUIRED_VARS = ["GOOGLE_CLIENT_EMAIL", "GOOGLE_PRIVATE_KEY", "GOOGLE_CALENDAR_ID"];

describeIntegration("GCalService (live)", REQUIRED_VARS, (env) => {
	const calendar = new GCalService({
		clientEmail: env.GOOGLE_CLIENT_EMAIL,
		privateKey: env.GOOGLE_PRIVATE_KEY,
		calendarId: env.GOOGLE_CALENDAR_ID,
	});

	it("creates and deletes a calendar event", async () => {
		const start = new Date("2026-01-01T09:00:00Z");
		const end = new Date("2026-01-01T10:00:00Z");

		const event = await calendar.createEvent({
			summary: "[jadoo integration test — safe to delete]",
			start,
			end,
		});

		expect(event.id).toBeDefined();
		expect(event.id.length).toBeGreaterThan(0);
		expect(event.summary).toContain("jadoo integration test");

		// Clean up
		await calendar.deleteEvent(event.id);
	});

	it("lists events in a time range", async () => {
		const start = new Date("2026-01-01T09:00:00Z");
		const end = new Date("2026-01-01T17:00:00Z");

		// Create a test event
		const event = await calendar.createEvent({
			summary: "[jadoo integration test — list test]",
			start,
			end: new Date("2026-01-01T10:00:00Z"),
		});

		try {
			const events = await calendar.listEvents({
				timeMin: start,
				timeMax: end,
			});

			// Should find at least our test event
			const found = events.find((e) => e.id === event.id);
			expect(found).toBeDefined();
			expect(found?.summary).toContain("jadoo integration test");
		} finally {
			// Always clean up
			await calendar.deleteEvent(event.id);
		}
	});
});
