import OpenAI from "openai";

let cachedClient: OpenAI | null = null;

function getClient(): OpenAI {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required");
  }
  cachedClient = new OpenAI({ apiKey });
  return cachedClient;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const all: number[][] = [];
  const batchSize = 20;

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const response = await getClient().embeddings.create({
      model: "text-embedding-3-small",
      input: batch
    });
    all.push(...response.data.map((d) => d.embedding));
  }

  return all;
}

export async function generateAssist(input: {
  retrievedChunks: string[];
  recentTranscript: string;
  interviewerQuestion?: string;
}): Promise<string> {
  const prompt = `You are a real-time interview copilot.\n\nContext:\n- The user has uploaded prep material.\n- Focus on the interviewer turn and full recent conversation context.\n\nInterviewer Turn:\n${input.interviewerQuestion ?? "Not explicitly detected"}\n\nPrep Material:\n${input.retrievedChunks.join("\n---\n")}\n\nRecent Conversation:\n${input.recentTranscript}\n\nInstructions:\n- Generate a natural spoken response the user can say next.\n- Prefer medium-long depth unless simple prompt.\n- If simple/direct: 2-4 sentences.\n- If behavioral/system/design: 5-8 sentences.\n- No bullets. No labels. Plain text only.`;

  const response = await getClient().responses.create({
    model: "gpt-4.1-mini",
    input: prompt,
    temperature: 0.35,
    max_output_tokens: 700
  });

  const text = (response.output_text || "").replace(/\s+/g, " ").trim();
  if (!text.length) {
    return "I would answer by directly addressing the question and tying it to a concrete project outcome.";
  }

  const sentenceSplit = text.match(/[^.!?]+[.!?]?/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  const clippedSentences = sentenceSplit.slice(0, 8).join(" ").trim();
  const clippedWords = clippedSentences.split(" ").filter(Boolean).slice(0, 220).join(" ");

  return clippedWords || "I would answer by directly addressing the question and tying it to a concrete project outcome.";
}
