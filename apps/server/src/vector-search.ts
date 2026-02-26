import { embedTexts } from "./openai-service.js";
import { memoryStore } from "./store.js";

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (!magA || !magB) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export async function retrieveRelevantChunks(query: string, topK = 3): Promise<string[]> {
  const chunks = memoryStore.getPrepChunks();
  if (!chunks.length || !query.trim()) return [];
  const [queryEmbedding] = await embedTexts([query]);
  if (!queryEmbedding) return [];

  return [...chunks]
    .map((chunk) => ({ text: chunk.text, score: cosine(queryEmbedding, chunk.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((x) => x.text);
}
