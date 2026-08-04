export type SupportedLanguage = {
	code: string;
	label: string;
};

export const DEFAULT_KNOWN_LANGUAGE = "en";
export const DEFAULT_TARGET_LANGUAGE = "pt-BR";

export const SUPPORTED_LANGUAGES: SupportedLanguage[] = [
	{ code: "en", label: "English" },
	{ code: "pt-BR", label: "Portuguese, Brazil" },
	{ code: "es", label: "Spanish" },
	{ code: "fr", label: "French" },
	{ code: "de", label: "German" },
	{ code: "it", label: "Italian" },
	{ code: "nl", label: "Dutch" },
	{ code: "sv", label: "Swedish" },
	{ code: "nb", label: "Norwegian Bokmål" },
	{ code: "da", label: "Danish" },
	{ code: "pl", label: "Polish" },
	{ code: "cs", label: "Czech" },
	{ code: "ro", label: "Romanian" },
	{ code: "el", label: "Greek" },
	{ code: "tr", label: "Turkish" },
	{ code: "ru", label: "Russian" },
	{ code: "ar", label: "Arabic" },
	{ code: "hi", label: "Hindi" },
	{ code: "ja", label: "Japanese" },
	{ code: "zh-CN", label: "Mandarin Chinese, Simplified" },
];

const LANGUAGE_CODES = new Set(SUPPORTED_LANGUAGES.map((language) => language.code));

export function isSupportedLanguage(code: string): boolean {
	return LANGUAGE_CODES.has(code);
}

export function getLanguageLabel(code: string): string {
	return SUPPORTED_LANGUAGES.find((language) => language.code === code)?.label ?? code;
}
