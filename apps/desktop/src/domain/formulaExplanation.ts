export type FormulaExplanation = {
  intuition: string;
  observations: string[];
  symbols: string[];
};

const SYMBOL_PATTERN = /(?:[A-Za-zΑ-Ωα-ω][A-Za-zΑ-Ωα-ω\d]*|[∑∫∏√])/gu;
const IGNORED_SYMBOLS = new Set(["sin", "cos", "tan", "log", "ln", "exp", "softmax"]);

export function explainFormulaStructure(source: string): FormulaExplanation {
  const formula = source.trim();
  const lower = formula.toLocaleLowerCase("en");
  let intuition = "这段表达式描述了若干量之间的计算关系；需要结合上下文定义确认每个符号的具体含义。";
  if (lower.includes("softmax")) {
    intuition = "它先把一组分数归一化为总和为 1 的权重，再用这些权重突出更相关的信息。";
  } else if (/[∑Σ]/u.test(formula)) {
    intuition = "它把多个局部项累加成一个总体量，求和范围决定哪些信息被纳入。";
  } else if (/[∫]/u.test(formula)) {
    intuition = "它通过积分累计连续范围内的贡献，积分上下限决定考察区间。";
  } else if (/=/.test(formula)) {
    intuition = "等号左侧是目标量，右侧给出由已知量计算它的规则。";
  }

  const observations: string[] = [];
  if (/softmax/iu.test(formula)) observations.push("softmax 表示归一化权重，但不能仅凭公式确定归一化维度。");
  if (/[√]/u.test(formula) || /sqrt/iu.test(formula)) observations.push("平方根项常用于尺度调整；具体原因应回看公式前后的说明。");
  if (/[ᵀ]|\^\s*T\b|\\top/iu.test(formula)) observations.push("转置符号改变矩阵方向，需核对相乘维度是否匹配。");
  if (/[∑Σ]/u.test(formula)) observations.push("求和符号需要结合上下标确认索引与范围。");
  if (observations.length === 0) observations.push("当前只做符号结构分析，不推断论文未给出的假设或定义。");

  const symbols = [...new Set(formula.match(SYMBOL_PATTERN) ?? [])]
    .filter((symbol) => !IGNORED_SYMBOLS.has(symbol.toLocaleLowerCase("en")))
    .slice(0, 12);
  return { intuition, observations, symbols };
}
