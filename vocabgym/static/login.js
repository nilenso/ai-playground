const message = document.getElementById("auth-message");
const registerForm = document.getElementById("register-form");
const loginForm = document.getElementById("login-form");

function showMessage(text, kind = "error") {
	message.hidden = false;
	message.className = `message ${kind}`;
	message.textContent = text;
}

function clearMessage() {
	message.hidden = true;
	message.className = "message";
	message.textContent = "";
}

function toBase64Url(buffer) {
	const bytes = new Uint8Array(buffer);
	let value = "";
	for (const byte of bytes) value += String.fromCharCode(byte);
	return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value) {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
	const binary = atob(padded);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function prepareRegistrationOptions(options) {
	return {
		...options,
		challenge: fromBase64Url(options.challenge),
		user: {
			...options.user,
			id: fromBase64Url(options.user.id),
		},
		excludeCredentials: (options.excludeCredentials || []).map((credential) => ({
			...credential,
			id: fromBase64Url(credential.id),
		})),
	};
}

function prepareAuthenticationOptions(options) {
	return {
		...options,
		challenge: fromBase64Url(options.challenge),
		allowCredentials: (options.allowCredentials || []).map((credential) => ({
			...credential,
			id: fromBase64Url(credential.id),
		})),
	};
}

function serializeRegistrationCredential(credential) {
	return {
		id: credential.id,
		rawId: toBase64Url(credential.rawId),
		type: credential.type,
		response: {
			attestationObject: toBase64Url(credential.response.attestationObject),
			clientDataJSON: toBase64Url(credential.response.clientDataJSON),
			transports: typeof credential.response.getTransports === "function" ? credential.response.getTransports() : [],
		},
		clientExtensionResults: credential.getClientExtensionResults(),
		authenticatorAttachment: credential.authenticatorAttachment,
	};
}

function serializeAuthenticationCredential(credential) {
	return {
		id: credential.id,
		rawId: toBase64Url(credential.rawId),
		type: credential.type,
		response: {
			authenticatorData: toBase64Url(credential.response.authenticatorData),
			clientDataJSON: toBase64Url(credential.response.clientDataJSON),
			signature: toBase64Url(credential.response.signature),
			userHandle: credential.response.userHandle ? toBase64Url(credential.response.userHandle) : null,
		},
		clientExtensionResults: credential.getClientExtensionResults(),
		authenticatorAttachment: credential.authenticatorAttachment,
	};
}

async function postJson(url, body) {
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(data.error || "Request failed.");
	return data;
}

registerForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	clearMessage();
	if (!globalThis.PublicKeyCredential) {
		showMessage("This browser does not support passkeys.");
		return;
	}
	const form = new FormData(registerForm);
	const payload = {
		username: String(form.get("username") || ""),
		displayName: String(form.get("displayName") || ""),
	};
	try {
		const options = await postJson("/auth/register/options", payload);
		const credential = await navigator.credentials.create({ publicKey: prepareRegistrationOptions(options) });
		if (!credential) throw new Error("Passkey registration was cancelled.");
		await postJson("/auth/register/verify", { ...payload, response: serializeRegistrationCredential(credential) });
		globalThis.location.href = "/";
	} catch (error) {
		showMessage(error instanceof Error ? error.message : "Registration failed.");
	}
});

loginForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	clearMessage();
	if (!globalThis.PublicKeyCredential) {
		showMessage("This browser does not support passkeys.");
		return;
	}
	const form = new FormData(loginForm);
	const payload = { username: String(form.get("username") || "") };
	try {
		const options = await postJson("/auth/login/options", payload);
		const credential = await navigator.credentials.get({ publicKey: prepareAuthenticationOptions(options) });
		if (!credential) throw new Error("Passkey sign-in was cancelled.");
		await postJson("/auth/login/verify", { ...payload, response: serializeAuthenticationCredential(credential) });
		globalThis.location.href = "/";
	} catch (error) {
		showMessage(error instanceof Error ? error.message : "Sign-in failed.");
	}
});
