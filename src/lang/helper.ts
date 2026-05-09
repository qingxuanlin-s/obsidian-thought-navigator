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

function readObsidianLanguage(): keyof typeof localeMap | null {
    const obsidianApp = (window as any).app;
    const vault = obsidianApp?.vault;
    const getConfig = vault?.getConfig;
    const configCandidates = [
        typeof getConfig === "function" ? getConfig.call(vault, "language") : null,
        typeof getConfig === "function" ? getConfig.call(vault, "locale") : null,
        typeof getConfig === "function" ? getConfig.call(vault, "appLanguage") : null,
        obsidianApp?.setting?.language,
        obsidianApp?.setting?.locale,
        obsidianApp?.settings?.language,
        obsidianApp?.settings?.locale,
        vault?.config?.language,
        vault?.config?.locale,
    ];

    for (const candidate of configCandidates) {
        const locale = normalizeLanguage(candidate);
        if (locale) return locale;
    }

    return null;
}

function getLocale(): Partial<typeof en> {
    const lang = readObsidianLanguage()
        || normalizeLanguage(window.localStorage.getItem("language"))
        || "en";
    return localeMap[lang] || en;
}

export function t(text: keyof typeof en): string {
    const locale = getLocale();
    return (locale && locale[text]) || en[text];
}
