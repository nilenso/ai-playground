PRAGMA foreign_keys = ON;

CREATE TABLE users (
	id TEXT PRIMARY KEY,
	username TEXT UNIQUE NOT NULL,
	display_name TEXT,
	role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
	passkey_reset_required INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE passkey_credentials (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	credential_id TEXT UNIQUE NOT NULL,
	public_key TEXT NOT NULL,
	counter INTEGER NOT NULL,
	transports_json TEXT,
	created_at TEXT NOT NULL,
	last_used_at TEXT,
	revoked_at TEXT,
	FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX passkey_credentials_one_active_per_user
	ON passkey_credentials(user_id)
	WHERE revoked_at IS NULL;

CREATE TABLE sessions (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	created_at TEXT NOT NULL,
	last_seen_at TEXT NOT NULL,
	user_agent TEXT,
	ip_hash TEXT,
	FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE vocab_entries (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	source_term TEXT NOT NULL,
	normalized_source_term TEXT NOT NULL,
	known_language TEXT NOT NULL,
	target_language TEXT NOT NULL,
	part_of_speech TEXT,
	chosen_translation TEXT NOT NULL,
	register_label TEXT,
	when_to_use TEXT,
	explanation TEXT NOT NULL,
	example_target TEXT,
	example_known TEXT,
	notes_json TEXT,
	model_name TEXT NOT NULL,
	created_at TEXT NOT NULL,
	FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
	UNIQUE(user_id, normalized_source_term, known_language, target_language, chosen_translation)
);

CREATE INDEX vocab_entries_user_id_created_at_idx ON vocab_entries(user_id, created_at DESC);

CREATE TABLE admin_audit_log (
	id TEXT PRIMARY KEY,
	admin_user_id TEXT NOT NULL,
	target_user_id TEXT,
	action TEXT NOT NULL,
	metadata_json TEXT,
	created_at TEXT NOT NULL,
	FOREIGN KEY(admin_user_id) REFERENCES users(id) ON DELETE CASCADE,
	FOREIGN KEY(target_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX admin_audit_log_created_at_idx ON admin_audit_log(created_at DESC);
