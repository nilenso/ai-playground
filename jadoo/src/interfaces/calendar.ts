/**
 * Calendar service interface.
 * Abstracts over any calendar provider (Google Calendar, etc.)
 */

export interface CalendarEvent {
	id: string;
	summary: string;
	description?: string;
	start: Date;
	end: Date;
	allDay?: boolean;
	attendees?: string[];
	location?: string;
}

export interface CreateEventRequest {
	summary: string;
	description?: string;
	start: Date;
	end: Date;
	allDay?: boolean;
	attendees?: string[];
	location?: string;
}

export interface ListEventsRequest {
	timeMin: Date;
	timeMax: Date;
	query?: string;
	maxResults?: number;
}

export interface CalendarService {
	/**
	 * List events within a time range.
	 */
	listEvents(request: ListEventsRequest): Promise<CalendarEvent[]>;

	/**
	 * Create a new calendar event.
	 */
	createEvent(request: CreateEventRequest): Promise<CalendarEvent>;

	/**
	 * Delete an event by ID.
	 */
	deleteEvent(eventId: string): Promise<void>;
}
