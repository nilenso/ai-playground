const data = JSON.parse(document.getElementById("app-data").textContent);
const searchForm = document.getElementById("search-form");
const backButton = document.getElementById("back-button");
const appMessage = document.getElementById("app-message");
const resultsRoot = document.getElementById("results-root");
const vocabRoot = document.getElementById("vocab-root");

let vocabEntries = data.vocabEntries;
let activeResults = null;

function escapeHtml(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function showMessage(text, kind = "error") {
	appMessage.hidden = false;
	appMessage.className = `message ${kind}`;
	appMessage.textContent = text;
}

function clearMessage() {
	appMessage.hidden = true;
	appMessage.className = "message";
	appMessage.textContent = "";
}

function renderVocab(entries) {
	if (!entries.length) {
		vocabRoot.innerHTML =
			'<div class="empty-state"><h2>Your vocab list is empty</h2><p>Search above and save a translation option to start building it.</p></div>';
		return;
	}
	vocabRoot.innerHTML = `<div class="stack">${
		entries
			.map(
				(entry) => `
		<article class="vocab-card">
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

function renderResults(result) {
	const generalNotes = (result.generalNotes || []).length
		? `<div class="message">${result.generalNotes.map((note) => `<div>${escapeHtml(note)}</div>`).join("")}</div>`
		: "";
	resultsRoot.innerHTML = `
		<div class="stack">
			<div>
				<h2>${escapeHtml(result.normalizedSourceTerm)}</h2>
				<p class="muted">${escapeHtml(result.knownLanguage)} → ${escapeHtml(result.targetLanguage)}${
		result.partOfSpeech ? ` · ${escapeHtml(result.partOfSpeech)}` : ""
	}</p>
			</div>
			${generalNotes}
			${
		result.options
			.map(
				(option, index) => `
				<article class="result-card">
					<div class="card-header">
						<div>
							<h3>${escapeHtml(option.translation)}</h3>
							<div class="result-meta">
								${option.register ? `<span class="pill">${escapeHtml(option.register)}</span>` : ""}
								${
					typeof option.confidence === "number"
						? `<span class="pill">confidence ${(option.confidence * 100).toFixed(0)}%</span>`
						: ""
				}
							</div>
						</div>
						<button type="button" class="save-option" data-option-index="${index}">Save</button>
					</div>
					<p><strong>When to use:</strong> ${escapeHtml(option.whenToUse)}</p>
					<p><strong>Explanation:</strong> ${escapeHtml(option.explanation)}</p>
					<p><strong>Example:</strong> ${escapeHtml(option.exampleTarget)}</p>
					<p><strong>Meaning:</strong> ${escapeHtml(option.exampleKnown)}</p>
					${
					(option.notes || []).length
						? `<ul>${option.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>`
						: ""
				}
				</article>`,
			)
			.join("")
	}
		</div>`;
}

async function postJson(url, body, method = "POST") {
	const controller = new AbortController();
	const timeout = globalThis.setTimeout(() => controller.abort("Request timed out"), 25_000);
	try {
		const response = await fetch(url, {
			method,
			headers: body ? { "Content-Type": "application/json" } : undefined,
			body: body ? JSON.stringify(body) : undefined,
			signal: controller.signal,
		});
		const data = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(data.error || "Request failed.");
		return data;
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error("Request timed out after 25 seconds. Please try again.");
		}
		throw error;
	} finally {
		globalThis.clearTimeout(timeout);
	}
}

async function refreshVocab() {
	const response = await fetch("/api/vocab");
	const payload = await response.json();
	vocabEntries = payload.entries;
	if (!activeResults) renderVocab(vocabEntries);
}

searchForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	clearMessage();
	const form = new FormData(searchForm);
	const payload = {
		term: String(form.get("term") || ""),
		knownLanguage: String(form.get("knownLanguage") || data.defaults.knownLanguage),
		targetLanguage: String(form.get("targetLanguage") || data.defaults.targetLanguage),
	};
	if (payload.knownLanguage === payload.targetLanguage) {
		showMessage("Choose two different languages.");
		return;
	}
	try {
		showMessage("Searching…", "success");
		const response = await postJson("/api/search", payload);
		activeResults = response.result;
		renderResults(activeResults);
		resultsRoot.hidden = false;
		vocabRoot.hidden = true;
		backButton.hidden = false;
		showMessage("Search complete.", "success");
	} catch (error) {
		showMessage(error instanceof Error ? error.message : "Search failed.");
	}
});

backButton.addEventListener("click", () => {
	activeResults = null;
	resultsRoot.hidden = true;
	vocabRoot.hidden = false;
	backButton.hidden = true;
	clearMessage();
	renderVocab(vocabEntries);
});

resultsRoot.addEventListener("click", async (event) => {
	const target = event.target;
	if (!(target instanceof HTMLElement)) return;
	const button = target.closest(".save-option");
	if (!button || !activeResults) return;
	const index = Number(button.getAttribute("data-option-index"));
	const option = activeResults.options[index];
	try {
		await postJson("/api/vocab", {
			sourceTerm: activeResults.sourceTerm,
			normalizedSourceTerm: activeResults.normalizedSourceTerm,
			knownLanguage: activeResults.knownLanguage,
			targetLanguage: activeResults.targetLanguage,
			partOfSpeech: activeResults.partOfSpeech || null,
			translation: option.translation,
			register: option.register || null,
			whenToUse: option.whenToUse,
			explanation: option.explanation,
			exampleTarget: option.exampleTarget,
			exampleKnown: option.exampleKnown,
			notes: option.notes || [],
			modelName: "openrouter/mistralai/mistral-small-2603",
		});
		await refreshVocab();
		showMessage("Saved to your vocab list.", "success");
	} catch (error) {
		showMessage(error instanceof Error ? error.message : "Could not save vocab entry.");
	}
});

vocabRoot.addEventListener("click", async (event) => {
	const target = event.target;
	if (!(target instanceof HTMLElement)) return;
	const button = target.closest(".delete-vocab");
	if (!button) return;
	const entryId = button.getAttribute("data-entry-id");
	if (!entryId) return;
	try {
		await postJson(`/api/vocab/${entryId}`, null, "DELETE");
		await refreshVocab();
		showMessage("Deleted from your vocab list.", "success");
	} catch (error) {
		showMessage(error instanceof Error ? error.message : "Could not delete vocab entry.");
	}
});

renderVocab(vocabEntries);
