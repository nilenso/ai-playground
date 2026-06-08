/**
 * Harvest time-tracking service interface.
 * Abstracts over the Harvest API for leave time entry management.
 */

export type LeaveType = "full" | "half_am" | "half_pm" | "specific";
export type LeaveCategory = "vacation" | "sick";

export interface HarvestTimeEntry {
	id: number;
	userId: number;
	projectId: number;
	taskId: number;
	date: string; // YYYY-MM-DD
	hours: number;
	notes: string | null;
}

export interface CreateTimeEntryRequest {
	/** Harvest user ID (not Slack user ID) */
	harvestUserId: number;
	date: string; // YYYY-MM-DD
	leaveType: LeaveType;
	category: LeaveCategory;
	hours?: number;
	notes?: string;
}

export interface HarvestUser {
	id: number;
	firstName: string;
	lastName: string;
	email: string;
	isActive: boolean;
}

export interface HarvestService {
	/**
	 * Create a time entry for a leave day.
	 * Returns the created entry ID.
	 */
	createTimeEntry(request: CreateTimeEntryRequest): Promise<number>;

	/**
	 * Delete a time entry by ID.
	 */
	deleteTimeEntry(entryId: number): Promise<void>;

	/**
	 * Fetch all active users from Harvest.
	 */
	getUsers(): Promise<HarvestUser[]>;

	/**
	 * Check if Harvest is reachable.
	 */
	checkConnection(): Promise<boolean>;
}
