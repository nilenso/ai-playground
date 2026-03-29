import { describe, expect, it } from "bun:test";
import { MockHarvestService } from "./mocks.js";

describe("MockHarvestService", () => {
	it("creates time entries and returns incrementing IDs", async () => {
		const harvest = new MockHarvestService();

		const id1 = await harvest.createTimeEntry({
			harvestUserId: 42,
			date: "2026-03-16",
			leaveType: "full",
			category: "vacation",
		});
		const id2 = await harvest.createTimeEntry({
			harvestUserId: 42,
			date: "2026-03-17",
			leaveType: "half_am",
			category: "sick",
		});

		expect(id1).toBe(1000);
		expect(id2).toBe(1001);
		expect(harvest.createdEntries).toHaveLength(2);
	});

	it("records created entry details", async () => {
		const harvest = new MockHarvestService();

		await harvest.createTimeEntry({
			harvestUserId: 99,
			date: "2026-03-20",
			leaveType: "half_pm",
			category: "sick",
			notes: "Doctor appointment",
		});

		expect(harvest.createdEntries[0]).toEqual({
			harvestUserId: 99,
			date: "2026-03-20",
			leaveType: "half_pm",
			category: "sick",
			notes: "Doctor appointment",
		});
	});

	it("deletes entries and records IDs", async () => {
		const harvest = new MockHarvestService();

		await harvest.deleteTimeEntry(1000);
		await harvest.deleteTimeEntry(1001);

		expect(harvest.deletedEntryIds).toEqual([1000, 1001]);
	});

	it("returns configured users", async () => {
		const harvest = new MockHarvestService();
		harvest.users.push(
			{ id: 1, firstName: "Alice", lastName: "Smith", email: "alice@example.com", isActive: true },
			{ id: 2, firstName: "Bob", lastName: "Jones", email: "bob@example.com", isActive: true },
		);

		const users = await harvest.getUsers();
		expect(users).toHaveLength(2);
		expect(users[0].firstName).toBe("Alice");
	});

	it("checks connection", async () => {
		const harvest = new MockHarvestService();
		expect(await harvest.checkConnection()).toBe(true);
	});

	it("can simulate create errors", async () => {
		const harvest = new MockHarvestService();
		harvest.createError = "Harvest API rate limited";

		expect(
			harvest.createTimeEntry({
				harvestUserId: 42,
				date: "2026-03-16",
				leaveType: "full",
				category: "vacation",
			}),
		).rejects.toThrow("Harvest API rate limited");

		// No entry was recorded
		expect(harvest.createdEntries).toHaveLength(0);
	});
});
