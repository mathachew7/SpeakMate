export function chunkText(text: string, maxWords = 420, overlapWords = 70): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return [];

  const chunks: string[] = [];
  let i = 0;
  while (i < words.length) {
    const end = Math.min(words.length, i + maxWords);
    chunks.push(words.slice(i, end).join(" "));
    if (end >= words.length) break;
    i = Math.max(i + 1, end - overlapWords);
  }

  return chunks;
}
