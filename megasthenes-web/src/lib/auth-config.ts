// Auth provider enum - stored as integer in database
export enum AuthProvider {
	GitHub = 1,
	GitLab = 2,
	Google = 3,
}

// Token expiry in days
export const TOKEN_EXPIRY_DAYS = 30;

// OAuth and JWT configuration
export const AUTH_CONFIG = {
	github: {
		clientId: process.env.GITHUB_CLIENT_ID || "",
		clientSecret: process.env.GITHUB_CLIENT_SECRET || "",
		authorizeUrl: "https://github.com/login/oauth/authorize",
		tokenUrl: "https://github.com/login/oauth/access_token",
		userUrl: "https://api.github.com/user",
		scopes: ["read:user", "user:email"],
	},
	jwt: {
		secret: process.env.JWT_SECRET || "development-secret-change-in-production",
		expiresIn: TOKEN_EXPIRY_DAYS * 24 * 60 * 60, // 30 days in seconds
	},
	app: {
		url: process.env.APP_URL || "http://localhost:3000",
	},
} as const;

export function validateAuthConfig(): void {
	if (!AUTH_CONFIG.github.clientId) {
		throw new Error("GITHUB_CLIENT_ID environment variable is required");
	}
	if (!AUTH_CONFIG.github.clientSecret) {
		throw new Error("GITHUB_CLIENT_SECRET environment variable is required");
	}
	if (AUTH_CONFIG.jwt.secret === "development-secret-change-in-production" && process.env.NODE_ENV === "production") {
		throw new Error("JWT_SECRET must be set in production");
	}
}
