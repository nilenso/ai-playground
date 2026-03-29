/**
 * Integration tests for HarvestAPIService against the real Harvest API.
 *
 * Requires: HARVEST_ACCESS_TOKEN, HARVEST_ACCOUNT_ID, HARVEST_PROJECT_ID,
 *           HARVEST_VACATION_TASK_ID, HARVEST_SICK_TASK_ID
 *
 * These tests create real time entries and clean them up afterwards.
 */

import { HarvestAPIService } from "../../src/services/harvest/harvest-service.js";
import { describeIntegration, expect, it } from "./helpers.js";

const REQUIRED_VARS = [
	"HARVEST_ACCESS_TOKEN",
	"HARVEST_ACCOUNT_ID",
	"HARVEST_PROJECT_ID",
	"HARVEST_VACATION_TASK_ID",
	"HARVEST_SICK_TASK_ID",
];

describeIntegration("HarvestAPIService (live)", REQUIRED_VARS, (env) => {
	const config = {
		accessToken: env.HARVEST_ACCESS_TOKEN,
		accountId: env.HARVEST_ACCOUNT_ID,
		projectId: Number.parseInt(env.HARVEST_PROJECT_ID, 10),
		vacationTaskId: Number.parseInt(env.HARVEST_VACATION_TASK_ID, 10),
		sickTaskId: Number.parseInt(env.HARVEST_SICK_TASK_ID, 10),
	};
	const harvest = new HarvestAPIService(config);

	it("checkConnection returns true", async () => {
		const ok = await harvest.checkConnection();
		expect(ok).toBe(true);
	});

	it("getUsers returns at least one user", async () => {
		const users = await harvest.getUsers();
		expect(users.length).toBeGreaterThan(0);
		expect(users[0].id).toBeGreaterThan(0);
		expect(users[0].email).toBeDefined();
	});

	it("creates and deletes a vacation time entry", async () => {
		const users = await harvest.getUsers();
		expect(users.length).toBeGreaterThan(0);

		const testDate = "2026-01-01";

		const entryId = await harvest.createTimeEntry({
			harvestUserId: users[0].id,
			date: testDate,
			leaveType: "full",
			category: "vacation",
			notes: "[jadoo integration test — safe to delete]",
		});

		expect(entryId).toBeGreaterThan(0);

		// Clean up
		await harvest.deleteTimeEntry(entryId);
	});

	it("creates and deletes a half-day sick entry", async () => {
		const users = await harvest.getUsers();
		expect(users.length).toBeGreaterThan(0);

		const testDate = "2026-01-02";

		const entryId = await harvest.createTimeEntry({
			harvestUserId: users[0].id,
			date: testDate,
			leaveType: "half_am",
			category: "sick",
			notes: "[jadoo integration test — safe to delete]",
		});

		expect(entryId).toBeGreaterThan(0);

		await harvest.deleteTimeEntry(entryId);
	});
});
