import zh from "./locale/zh";
import en from "./locale/en";

const localeMap: { [k: string]: Partial<typeof en>; } = {
    en,
    zh,
};

function normalizeLanguage(lang: unknown): keyof typeof localeMap | null {
    if (typeof lang !== "string") return null;

    const normalized = lang.trim().toLowerCase().replace("_", "-");
    if (!normalized) return null;
    if (normalized.startsWith("zh")) return "zh";
    if (normalized.startsWith("en")) return "en";
    return normalized in localeMap ? normalized : null;
}

function getLocale(): Partial<typeof en> {
    const lang = normalizeLanguage(window.localStorage.getItem("language"))
        || normalizeLanguage(navigator.language)
        || "en";
    return localeMap[lang] || en;
}

export function t(text: keyof typeof en): string {
    const locale = getLocale();
    return (locale && locale[text]) || en[text];
}
