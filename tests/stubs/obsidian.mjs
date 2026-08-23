// Minimal stub of the "obsidian" module so the sync engine (which only uses
// normalizePath at runtime outside Obsidian classes) can run under Node tests.
export const normalizePath = (p) => p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
export const requestUrl = async () => {
	throw new Error("network access is disabled in tests");
};
export class Notice {}
export class Modal {}
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export const Platform = { isDesktopApp: false };
