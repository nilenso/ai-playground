/**
 * Harvest API service implementation.
 */

import type { HarvestConfig } from "../../config/index.js";
import type {
	CreateTimeEntryRequest,
	HarvestService,
	HarvestUser,
	LeaveCategory,
	LeaveType,
} from "../../interfaces/harvest.js";

const HARVEST_API_BASE = "https://api.harvestapp.com/v2";

const FULL_DAY_HOURS = 8.0;
const HALF_DAY_HOURS = 4.0;

function getHours(leaveType: LeaveType): number {
	return leaveType === "full" ? FULL_DAY_HOURS : HALF_DAY_HOURS;
}

function getTaskId(category: LeaveCategory, config: HarvestConfig): number {
	return category === "sick" ? config.sickTaskId : config.vacationTaskId;
}

function buildNotes(leaveType: LeaveType, category: LeaveCategory): string {
	const categoryLabel = category === "sick" ? "Sick" : "Vacation";
	if (leaveType === "full") return `Leave (${categoryLabel})`;
	if (leaveType === "half_am") return `Leave - Morning (${categoryLabel})`;
	return `Leave - Afternoon (${categoryLabel})`;
}

export class HarvestAPIService implements HarvestService {
	private readonly headers: Record<string, string>;
	private readonly config: HarvestConfig;

	constructor(config: HarvestConfig) {
		this.config = config;
		this.headers = {
			Authorization: `Bearer ${config.accessToken}`,
			"Harvest-Account-Id": config.accountId,
			"User-Agent": "Jadoo Leave Bot",
			"Content-Type": "application/json",
		};
	}

	async createTimeEntry(request: CreateTimeEntryRequest): Promise<number> {
		const hours = getHours(request.leaveType);
		const taskId = getTaskId(request.category, this.config);
		const notes = request.notes ?? buildNotes(request.leaveType, request.category);

		const payload = {
			user_id: request.harvestUserId,
			project_id: this.config.projectId,
			task_id: taskId,
			spent_date: request.date,
			hours,
			notes,
		};

		const response = await fetch(`${HARVEST_API_BASE}/time_entries`, {
			method: "POST",
			headers: this.headers,
			body: JSON.stringify(payload),
		});

		if (!response.ok) {
			const body = await response.text();
			throw new Error(`Harvest createTimeEntry failed (${response.status}): ${body}`);
		}

		const data = (await response.json()) as { id: number };
		return data.id;
	}

	async deleteTimeEntry(entryId: number): Promise<void> {
		const response = await fetch(`${HARVEST_API_BASE}/time_entries/${entryId}`, {
			method: "DELETE",
			headers: this.headers,
		});

		if (!response.ok) {
			const body = await response.text();
			throw new Error(`Harvest deleteTimeEntry failed (${response.status}): ${body}`);
		}
	}

	async getUsers(): Promise<HarvestUser[]> {
		const users: HarvestUser[] = [];
		let page = 1;

		while (true) {
			const url = `${HARVEST_API_BASE}/users?page=${page}&per_page=100&is_active=true`;
			const response = await fetch(url, { headers: this.headers });

			if (!response.ok) {
				const body = await response.text();
				throw new Error(`Harvest getUsers failed (${response.status}): ${body}`);
			}

			const data = (await response.json()) as {
				users: Array<{
					id: number;
					first_name: string;
					last_name: string;
					email: string;
					is_active: boolean;
				}>;
				page: number;
				total_pages: number;
			};

			for (const u of data.users) {
				users.push({
					id: u.id,
					firstName: u.first_name,
					lastName: u.last_name,
					email: u.email,
					isActive: u.is_active,
				});
			}

			if (data.page >= data.total_pages) break;
			page++;
		}

		return users;
	}

	async checkConnection(): Promise<boolean> {
		try {
			const response = await fetch(`${HARVEST_API_BASE}/users/me`, {
				headers: this.headers,
			});
			return response.ok;
		} catch {
			return false;
		}
	}
}
