import fs from "node:fs/promises";
import pdfParse from "pdf-parse";
import { chunkText } from "./chunking.js";
import { embedTexts } from "./openai-service.js";
import { memoryStore } from "./store.js";

export async function indexPrepFile(path: string, originalName: string) {
  const file = await fs.readFile(path);
  let text = "";

  if (originalName.toLowerCase().endsWith(".pdf")) {
    const parsed = await pdfParse(file);
    text = parsed.text || "";
  } else {
    text = file.toString("utf8");
  }

  const cleaned = text.replace(/\u0000/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) {
    memoryStore.setPrepChunks([]);
    return { chunksStored: 0 };
  }

  const chunks = chunkText(cleaned);
  const embeddings = await embedTexts(chunks);

  memoryStore.setPrepChunks(
    chunks.map((chunk, i) => ({
      id: `${Date.now()}-${i}`,
      text: chunk,
      embedding: embeddings[i] || []
    }))
  );

  return { chunksStored: chunks.length };
}
