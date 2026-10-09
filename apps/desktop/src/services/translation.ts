const TRANSLATION_ENDPOINT = "https://api.mymemory.translated.net/get";
export const MAX_TRANSLATION_CHARACTERS = 450;

type ProtectedText = { text: string; values: string[] };

const SCIENTIFIC_TOKEN = /(?:\$[^$]+\$|\\\([^)]*\\\)|\\\[[^\]]*\\\]|\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+|\[(?:\d+(?:\s*[-,]\s*\d+)*)\]|\b(?:Fig(?:ure)?|Table|Eq(?:uation)?)\.?\s*\d+[A-Za-z]?)/giu;

export class TranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranslationError";
  }
}

export function protectScientificTokens(value: string): ProtectedText {
  const values: string[] = [];
  return {
    text: value.replace(SCIENTIFIC_TOKEN, (token) => {
      const index = values.push(token) - 1;
      return ` __PAPERLENS_${index}__ `;
    }),
    values,
  };
}

export function restoreScientificTokens(value: string, tokens: readonly string[]): string {
  return tokens.reduce(
    (result, token, index) => result.split(`__PAPERLENS_${index}__`).join(token),
    value,
  ).replace(/\s+([,.;:!?])/g, "$1");
}

export async function translateEnglishToChinese(
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const source = text.trim();
  if (!source) throw new TranslationError("请先在 PDF 中选择英文原文。");
  if (source.length > MAX_TRANSLATION_CHARACTERS) {
    throw new TranslationError(`单次最多翻译 ${MAX_TRANSLATION_CHARACTERS} 个字符，请缩短选区。`);
  }

  const protectedText = protectScientificTokens(source);
  const url = new URL(TRANSLATION_ENDPOINT);
  url.searchParams.set("q", protectedText.text);
  url.searchParams.set("langpair", "en|zh-CN");

  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { Accept: "application/json" } });
  } catch {
    throw new TranslationError("翻译服务连接失败，原文仍保留在本地。");
  }
  if (!response.ok) throw new TranslationError(`翻译服务暂时不可用（HTTP ${response.status}）。`);

  const payload = await response.json() as {
    responseData?: { translatedText?: unknown };
    responseStatus?: unknown;
  };
  const translated = payload.responseData?.translatedText;
  if (typeof translated !== "string" || !translated.trim()) {
    throw new TranslationError("翻译服务没有返回有效译文。");
  }
  return restoreScientificTokens(translated.trim(), protectedText.values);
}
