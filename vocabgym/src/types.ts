export type UserRole = "admin" | "user";

export type User = {
	id: string;
	username: string;
	display_name: string | null;
	role: UserRole;
	passkey_reset_required: number;
	created_at: string;
	updated_at: string;
};

export type SessionRecord = {
	id: string;
	user_id: string;
	expires_at: string;
	created_at: string;
	last_seen_at: string;
	user_agent: string | null;
	ip_hash: string | null;
};

export type PasskeyCredential = {
	id: string;
	user_id: string;
	credential_id: string;
	public_key: string;
	counter: number;
	transports_json: string | null;
	created_at: string;
	last_used_at: string | null;
	revoked_at: string | null;
};

export type VocabEntry = {
	id: string;
	user_id: string;
	source_term: string;
	normalized_source_term: string;
	known_language: string;
	target_language: string;
	part_of_speech: string | null;
	chosen_translation: string;
	register_label: string | null;
	when_to_use: string | null;
	explanation: string;
	example_target: string | null;
	example_known: string | null;
	notes_json: string | null;
	model_name: string;
	created_at: string;
};
