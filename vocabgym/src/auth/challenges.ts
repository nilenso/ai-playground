type ChallengeType = "register" | "login";

type ChallengeRecord = {
	type: ChallengeType;
	username: string;
	challenge: string;
	userId: string;
	expiresAt: number;
};

export class ChallengeStore {
	#records = new Map<string, ChallengeRecord>();

	create(input: { type: ChallengeType; username: string; challenge: string; userId: string; ttlMs?: number }): void {
		this.cleanup();
		this.#records.set(this.key(input.type, input.username), {
			...input,
			expiresAt: Date.now() + (input.ttlMs ?? 10 * 60_000),
		});
	}

	consume(type: ChallengeType, username: string): ChallengeRecord | null {
		this.cleanup();
		const key = this.key(type, username);
		const record = this.#records.get(key) ?? null;
		if (!record) {
			return null;
		}
		this.#records.delete(key);
		return record;
	}

	private key(type: ChallengeType, username: string): string {
		return `${type}:${username.toLowerCase()}`;
	}

	private cleanup(): void {
		const now = Date.now();
		for (const [key, record] of this.#records.entries()) {
			if (record.expiresAt <= now) {
				this.#records.delete(key);
			}
		}
	}
}
