export type LeaveType = "full" | "half_am" | "half_pm";
export type LeaveCategory = "vacation" | "sick";

export interface CreateLeavePayload {
	dates: string[]; // YYYY-MM-DD
	leaveType: LeaveType;
	category: LeaveCategory;
	reason?: string;
}

export interface CancelLeavePayload {
	dates: string[]; // YYYY-MM-DD
}
