import type { PrepChunk, TranscriptLine } from "./types.js";

const MAX_TRANSCRIPT_LINES = 800;

class MemoryStore {
  private prepChunks: PrepChunk[] = [];
  private transcript: TranscriptLine[] = [];

  setPrepChunks(chunks: PrepChunk[]) {
    this.prepChunks = chunks;
  }

  getPrepChunks() {
    return this.prepChunks;
  }

  pushTranscript(line: TranscriptLine) {
    this.transcript = [...this.transcript.filter((x) => x.id !== line.id), line]
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-MAX_TRANSCRIPT_LINES);
  }

  getRecentTranscript(windowMs = 60_000) {
    const cutoff = Date.now() - windowMs;
    return this.transcript.filter((line) => line.isFinal && line.timestamp >= cutoff);
  }
}

export const memoryStore = new MemoryStore();
