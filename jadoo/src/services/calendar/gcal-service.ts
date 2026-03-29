/**
 * Google Calendar service implementation using @googleapis/calendar.
 */

import { calendar_v3, auth as gauth } from "@googleapis/calendar";
import type { GoogleCalendarConfig } from "../../config/index.js";
import type {
	CalendarEvent,
	CalendarService,
	CreateEventRequest,
	ListEventsRequest,
} from "../../interfaces/calendar.js";

function toCalendarEvent(event: calendar_v3.Schema$Event): CalendarEvent {
	return {
		id: event.id ?? "",
		summary: event.summary ?? "",
		description: event.description ?? undefined,
		start: new Date(event.start?.dateTime ?? event.start?.date ?? ""),
		end: new Date(event.end?.dateTime ?? event.end?.date ?? ""),
		attendees: event.attendees?.map((a) => a.email ?? "").filter(Boolean),
		location: event.location ?? undefined,
	};
}

export class GCalService implements CalendarService {
	private calendar: calendar_v3.Calendar;
	private calendarId: string;

	constructor(config: GoogleCalendarConfig) {
		this.calendarId = config.calendarId;

		const authClient = new gauth.JWT({
			email: config.clientEmail,
			key: config.privateKey.replace(/\\n/g, "\n"),
			scopes: ["https://www.googleapis.com/auth/calendar"],
		});

		this.calendar = new calendar_v3.Calendar({ auth: authClient });
	}

	async listEvents(request: ListEventsRequest): Promise<CalendarEvent[]> {
		const response = await this.calendar.events.list({
			calendarId: this.calendarId,
			timeMin: request.timeMin.toISOString(),
			timeMax: request.timeMax.toISOString(),
			q: request.query,
			maxResults: request.maxResults ?? 50,
			singleEvents: true,
			orderBy: "startTime",
		});

		return (response.data.items ?? []).map(toCalendarEvent);
	}

	async createEvent(request: CreateEventRequest): Promise<CalendarEvent> {
		const response = await this.calendar.events.insert({
			calendarId: this.calendarId,
			requestBody: {
				summary: request.summary,
				description: request.description,
				start: { dateTime: request.start.toISOString() },
				end: { dateTime: request.end.toISOString() },
				attendees: request.attendees?.map((email) => ({ email })),
				location: request.location,
			},
		});

		return toCalendarEvent(response.data);
	}

	async deleteEvent(eventId: string): Promise<void> {
		await this.calendar.events.delete({
			calendarId: this.calendarId,
			eventId,
		});
	}
}
