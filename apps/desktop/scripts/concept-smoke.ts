import { lookupChineseConcept } from "../src/services/conceptLookup";

async function run() {
  const results = [];
  for (const query of ["苹果", "NVIDIA V100 GPU", "自行车", "photosynthesis"]) {
    const result = await lookupChineseConcept(query);
    if (!result.summary || !result.sourceUrl.startsWith("https://")) throw new Error(`Invalid result: ${query}`);
    if (query === "photosynthesis" && !/[\u3400-\u9fff]/.test(result.summary)) throw new Error("Live English explanation was not translated");
    results.push({ query, title: result.title, summary: result.summary, source: result.sourceLabel });
  }
  return results;
}
void run().then((results) => {
  document.getElementById("result")!.textContent = JSON.stringify(results, null, 2);
  window.webkit.messageHandlers.result.postMessage(JSON.stringify({ done: true, ok: true, results }));
}).catch((error) => {
  window.webkit.messageHandlers.result.postMessage(JSON.stringify({ done: true, ok: false, error: String(error) }));
});
