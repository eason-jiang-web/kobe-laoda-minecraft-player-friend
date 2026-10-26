/**
 * Proves the DeepSeek key in .env actually works, for about a hundredth of a
 * cent. Never prints the key.
 *
 *   bun run --cwd apps/brain-deepseek key-check
 */
import { DeepSeekClient } from "../src/deepseek.js";

const key = process.env.DEEPSEEK_API_KEY ?? "";
const model = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-pro";
const baseUrl = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";

if (!key) {
  console.error("DEEPSEEK_API_KEY is empty — put it in .env at the repo root.");
  process.exit(2);
}

console.log("key: " + key.slice(0, 6) + "…" + key.slice(-4) + " (" + key.length + " chars)");
console.log("model: " + model + " @ " + baseUrl);

const ds = new DeepSeekClient({ apiKey: key, baseUrl, model, maxTokens: 24, temperature: 0 });

const started = Date.now();
try {
  const message = await ds.complete(
    [
      { role: "system", content: "Answer with exactly one word." },
      { role: "user", content: "Say ping." },
    ],
    [],
  );
  console.log("ok in " + (Date.now() - started) + "ms -> " + JSON.stringify(message.content));
} catch (e) {
  console.error("failed: " + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
}
