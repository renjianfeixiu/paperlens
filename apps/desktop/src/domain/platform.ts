export function isMacPlatform(platform = typeof navigator === "undefined" ? "" : navigator.platform): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

export function shortcutModifier(platform?: string): string {
  return isMacPlatform(platform) ? "⌘" : "Ctrl+";
}

export function hasCommandModifier(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey">,
  platform?: string,
): boolean {
  return !event.altKey && (isMacPlatform(platform) ? event.metaKey : event.ctrlKey);
}
