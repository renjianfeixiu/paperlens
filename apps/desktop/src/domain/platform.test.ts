import { describe, expect, it } from "vitest";
import { hasCommandModifier, shortcutModifier } from "./platform";

describe("desktop shortcuts", () => {
  it("uses Ctrl on Windows and Command on macOS", () => {
    expect(shortcutModifier("Win32")).toBe("Ctrl+");
    expect(shortcutModifier("MacIntel")).toBe("⌘");
    const ctrl = { ctrlKey: true, metaKey: false, altKey: false };
    expect(hasCommandModifier(ctrl, "Win32")).toBe(true);
    expect(hasCommandModifier(ctrl, "MacIntel")).toBe(false);
    expect(hasCommandModifier({ ctrlKey: false, metaKey: true, altKey: false }, "MacIntel")).toBe(true);
  });
  it("does not intercept AltGr combinations", () => {
    expect(hasCommandModifier({ ctrlKey: true, metaKey: false, altKey: true }, "Win32")).toBe(false);
  });
});
