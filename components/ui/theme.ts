// no "use client" here: app/layout.tsx is a server component and must read
// THEME_SCRIPT as a string, not as a client reference proxy.

export const THEME_STORAGE_KEY = "towncenter-theme";

export type Theme = "dark" | "light";
export type ThemePreference = Theme | "system";

// The server cannot read the OS preference; the first paint is corrected by THEME_SCRIPT.
export const DEFAULT_THEME: Theme = "light";
export const DEFAULT_THEME_PREFERENCE: ThemePreference = "system";

// Resolve the system preference before paint so the default follows the OS.
export const THEME_SCRIPT = `(function(){try{
var stored=null;try{stored=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});}catch(e){}
var t=stored==="light"||stored==="dark"?stored:(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");
document.documentElement.dataset.theme=t;
}catch(e){}})();`;
