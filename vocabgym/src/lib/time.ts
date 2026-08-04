export function nowIso(): string {
	return new Date().toISOString();
}

export function formatRelativeTime(value: string): string {
	const date = new Date(value);
	const deltaMs = Date.now() - date.getTime();
	const minute = 60_000;
	const hour = 60 * minute;
	const day = 24 * hour;

	if (deltaMs < minute) {
		return "just now";
	}
	if (deltaMs < hour) {
		return `${Math.floor(deltaMs / minute)}m ago`;
	}
	if (deltaMs < day) {
		return `${Math.floor(deltaMs / hour)}h ago`;
	}
	if (deltaMs < 7 * day) {
		return `${Math.floor(deltaMs / day)}d ago`;
	}
	return date.toLocaleString();
}
