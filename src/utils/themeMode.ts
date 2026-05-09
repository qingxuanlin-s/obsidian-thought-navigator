export type ThemeModeSetting = 'dark' | 'light' | 'auto';
export type ResolvedTheme = 'dark' | 'light';

/**
 * 把 themeMode 设置(可能是 'auto')解析为具体的 'light' | 'dark'。
 * 'auto' 时读 Obsidian body 的 theme-dark/theme-light 类。
 */
export function resolveThemeMode(themeMode: ThemeModeSetting | undefined): ResolvedTheme {
    if (themeMode === 'light' || themeMode === 'dark') {
        return themeMode;
    }
    return document.body.classList.contains('theme-dark') ? 'dark' : 'light';
}
