import { DEFAULT_KNOWN_LANGUAGE, DEFAULT_TARGET_LANGUAGE, SUPPORTED_LANGUAGES } from "../constants/languages.ts";
import { escapeHtml, jsonScript } from "../lib/html.ts";
import type { User } from "../types.ts";

type SerializedVocabEntry = {
	id: string;
	sourceTerm: string;
	translation: string;
	knownLanguage: string;
	knownLanguageLabel: string;
	targetLanguage: string;
	targetLanguageLabel: string;
	partOfSpeech: string | null;
	register: string | null;
	whenToUse: string | null;
	explanation: string;
	exampleTarget: string | null;
	exampleKnown: string | null;
	notes: string[];
	modelName: string;
	createdAt: string;
	createdAtRelative: string;
};

type AdminListRow = User & {
	active_credential_id: string | null;
	active_session_count: number;
};

export function renderLoginPage(): string {
	return renderLayout(
		"VocabGym · Passkey sign-in",
		`<main class="auth-grid">
			<section class="card">
				<h1>VocabGym</h1>
				<p class="muted">Passkey-only vocabulary search and saving.</p>
				<div id="auth-message" class="message" hidden></div>
			</section>
			<section class="card">
				<h2>Register</h2>
				<form id="register-form" class="stack">
					<label>
						<span>Username</span>
						<input name="username" autocomplete="username" required />
					</label>
					<label>
						<span>Display name</span>
						<input name="displayName" autocomplete="nickname" />
					</label>
					<button type="submit">Register with passkey</button>
				</form>
			</section>
			<section class="card">
				<h2>Sign in</h2>
				<form id="login-form" class="stack">
					<label>
						<span>Username</span>
						<input name="username" autocomplete="username webauthn" required />
					</label>
					<button type="submit">Sign in with passkey</button>
				</form>
			</section>
		</main>`,
		loginScript(),
	);
}

export function renderAppPage(input: {
	user: User;
	vocabEntries: SerializedVocabEntry[];
}): string {
	const user = input.user;
	const data = {
		languages: SUPPORTED_LANGUAGES,
		vocabEntries: input.vocabEntries,
		defaults: {
			knownLanguage: DEFAULT_KNOWN_LANGUAGE,
			targetLanguage: DEFAULT_TARGET_LANGUAGE,
		},
		user: {
			username: user.username,
			role: user.role,
		},
	};

	return renderLayout(
		"VocabGym",
		`<main class="page">
			<header class="header">
				<div>
					<h1>VocabGym</h1>
					<p class="muted">Search a word or phrase, compare nuance, and save the best option.</p>
				</div>
				<div class="header-actions">
					<span class="pill">${escapeHtml(user.username)} · ${escapeHtml(user.role)}</span>
					${user.role === "admin" ? '<a class="button secondary" href="/admin">Admin</a>' : ""}
					<form method="post" action="/auth/logout"><button class="secondary" type="submit">Logout</button></form>
				</div>
			</header>
			<section class="card">
				<form id="search-form" class="search-grid">
					<label>
						<span>Known language</span>
						<select name="knownLanguage">${renderLanguageOptions(DEFAULT_KNOWN_LANGUAGE)}</select>
					</label>
					<label>
						<span>Target language</span>
						<select name="targetLanguage">${renderLanguageOptions(DEFAULT_TARGET_LANGUAGE)}</select>
					</label>
					<label class="search-term">
						<span>Word or phrase</span>
						<input name="term" maxlength="80" placeholder="run, light, tomar cuidado..." required />
					</label>
					<div class="search-actions">
						<button type="submit">Search</button>
						<button id="back-button" class="secondary" type="button" hidden>Back to vocab list</button>
					</div>
				</form>
				<div id="app-message" class="message" hidden></div>
			</section>
			<section id="content-area" class="card content-area">
				<div id="results-root" hidden></div>
				<div id="vocab-root">${renderVocabListHtml(input.vocabEntries)}</div>
			</section>
			<script id="app-data" type="application/json">${jsonScript(data)}</script>
		</main>`,
		appScript(),
	);
}

export function renderAdminPage(input: { currentUser: User; users: AdminListRow[] }): string {
	return renderLayout(
		"VocabGym · Admin",
		`<main class="page">
			<header class="header">
				<div>
					<h1>Admin</h1>
					<p class="muted">Reset passkeys, which also revokes active sessions and writes an audit log entry.</p>
				</div>
				<div class="header-actions">
					<span class="pill">${escapeHtml(input.currentUser.username)}</span>
					<a class="button secondary" href="/">Back to app</a>
				</div>
			</header>
			<section class="card">
				<div class="admin-list">
					${
			input.users
				.map(
					(user) =>
						`<article class="admin-row">
								<div>
									<h2>${escapeHtml(user.username)}</h2>
									<p class="muted">role=${escapeHtml(user.role)} · reset_required=${
							user.passkey_reset_required === 1 ? "yes" : "no"
						}</p>
									<p class="muted">active credential=${
							user.active_credential_id ? "yes" : "no"
						} · active sessions=${user.active_session_count}</p>
								</div>
								<form method="post" action="/api/admin/users/${escapeHtml(user.id)}/reset-passkey">
									<button type="submit">Reset passkey</button>
								</form>
							</article>`,
				)
				.join("")
		}
				</div>
			</section>
		</main>`,
	);
}

function renderLayout(title: string, body: string, script = ""): string {
	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>${escapeHtml(title)}</title>
		<style>${styles()}</style>
	</head>
	<body>
		${body}
		${script}
	</body>
</html>`;
}

function renderLanguageOptions(selected: string): string {
	return SUPPORTED_LANGUAGES.map((language) => {
		const isSelected = language.code === selected ? " selected" : "";
		return `<option value="${escapeHtml(language.code)}"${isSelected}>${escapeHtml(language.label)}</option>`;
	}).join("");
}

function renderVocabListHtml(entries: SerializedVocabEntry[]): string {
	if (entries.length === 0) {
		return `<div class="empty-state"><h2>Your vocab list is empty</h2><p>Search above and save a translation option to start building it.</p></div>`;
	}
	return `<div class="stack">${
		entries
			.map(
				(entry) =>
					`<article class="vocab-card">
				<div class="card-header">
					<div>
						<h2>${escapeHtml(entry.sourceTerm)} → ${escapeHtml(entry.translation)}</h2>
						<p class="muted">${escapeHtml(entry.knownLanguageLabel)} → ${escapeHtml(entry.targetLanguageLabel)} · ${
						escapeHtml(entry.createdAtRelative)
					}</p>
					</div>
					<button class="danger delete-vocab" type="button" data-entry-id="${escapeHtml(entry.id)}">Delete</button>
				</div>
				${entry.partOfSpeech ? `<p><strong>Part of speech:</strong> ${escapeHtml(entry.partOfSpeech)}</p>` : ""}
				${entry.register ? `<p><strong>Register:</strong> ${escapeHtml(entry.register)}</p>` : ""}
				<p><strong>Explanation:</strong> ${escapeHtml(entry.explanation)}</p>
				${entry.whenToUse ? `<p><strong>When to use:</strong> ${escapeHtml(entry.whenToUse)}</p>` : ""}
				${entry.exampleTarget ? `<p><strong>Example:</strong> ${escapeHtml(entry.exampleTarget)}</p>` : ""}
				${entry.exampleKnown ? `<p><strong>Meaning:</strong> ${escapeHtml(entry.exampleKnown)}</p>` : ""}
			</article>`,
			)
			.join("")
	}</div>`;
}

function styles(): string {
	return `:root {
		color-scheme: light;
		font-family: Inter, ui-sans-serif, system-ui, sans-serif;
		background: #f8fafc;
		color: #0f172a;
	}
	* { box-sizing: border-box; }
	body { margin: 0; background: #f8fafc; color: #0f172a; }
	a { color: #2563eb; text-decoration: none; }
	button, .button {
		border: 0;
		border-radius: 0.75rem;
		padding: 0.75rem 1rem;
		font: inherit;
		background: #2563eb;
		color: white;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
	}
	button.secondary, .button.secondary { background: #e2e8f0; color: #0f172a; }
	button.danger { background: #dc2626; }
	input, select {
		width: 100%;
		padding: 0.75rem 0.9rem;
		border-radius: 0.75rem;
		border: 1px solid #cbd5e1;
		font: inherit;
		background: white;
	}
	label { display: grid; gap: 0.45rem; }
	span { font-weight: 600; }
	.page, .auth-grid { max-width: 1100px; margin: 0 auto; padding: 2rem 1rem 3rem; }
	.auth-grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
	.card {
		background: white;
		border: 1px solid #e2e8f0;
		border-radius: 1rem;
		padding: 1.25rem;
		box-shadow: 0 8px 24px rgba(15, 23, 42, 0.05);
	}
	.header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 1rem;
		margin-bottom: 1rem;
	}
	.header-actions { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
	.pill {
		background: #f1f5f9;
		border: 1px solid #cbd5e1;
		padding: 0.45rem 0.7rem;
		border-radius: 999px;
	}
	.search-grid {
		display: grid;
		grid-template-columns: 1fr 1fr 2fr auto;
		gap: 1rem;
		align-items: end;
	}
	.search-term { min-width: 0; }
	.search-actions { display: flex; gap: 0.75rem; align-items: end; }
	.content-area { margin-top: 1rem; }
	.stack { display: grid; gap: 1rem; }
	.muted { color: #475569; margin: 0; }
	.message {
		margin-top: 1rem;
		padding: 0.9rem 1rem;
		border-radius: 0.75rem;
		background: #eff6ff;
		border: 1px solid #bfdbfe;
	}
	.message.error { background: #fef2f2; border-color: #fecaca; color: #991b1b; }
	.message.success { background: #ecfdf5; border-color: #a7f3d0; color: #166534; }
	.vocab-card, .result-card, .admin-row {
		border: 1px solid #e2e8f0;
		border-radius: 0.9rem;
		padding: 1rem;
		background: #fcfcfd;
	}
	.card-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 1rem;
	}
	.empty-state { text-align: center; padding: 2rem 1rem; color: #475569; }
	.result-meta { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
	.result-meta .pill { font-size: 0.875rem; }
	.admin-list { display: grid; gap: 1rem; }
	.admin-row { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
	@media (max-width: 860px) {
		.search-grid { grid-template-columns: 1fr; }
		.search-actions { justify-content: flex-start; }
		.header, .admin-row, .card-header { flex-direction: column; }
	}`;
}

function loginScript(): string {
	return '<script type="module" src="/assets/login.js"></script>';
}

function appScript(): string {
	return '<script type="module" src="/assets/app.js"></script>';
}
