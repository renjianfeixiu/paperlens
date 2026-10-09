import { describe, expect, it, vi } from "vitest";
import {
  protectScientificTokens,
  restoreScientificTokens,
  translateEnglishToChinese,
} from "./translation";

describe("translation service", () => {
  it("protects equations, citations, figures and DOI values", () => {
    const source = "See Figure 2 and [3], where $x = y$; DOI 10.1000/XYZ.";
    const protectedText = protectScientificTokens(source);
    expect(protectedText.values).toEqual(["Figure 2", "[3]", "$x = y$", "10.1000/XYZ."]);
    expect(restoreScientificTokens(protectedText.text, protectedText.values)).toContain("$x = y$");
  });

  it("calls the translation endpoint and restores protected tokens", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({
      responseData: { translatedText: "参见 __PAPERLENS_0__。" },
    }), { status: 200 }));
    const result = await translateEnglishToChinese("See [12].", fetchMock);
    expect(result).toBe("参见 [12]。");
    expect(String(fetchMock.mock.calls[0][0])).toContain("langpair=en%7Czh-CN");
  });

  it("rejects oversized selections before using the network", async () => {
    const fetchMock = vi.fn();
    await expect(translateEnglishToChinese("a".repeat(451), fetchMock)).rejects.toThrow("450");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
