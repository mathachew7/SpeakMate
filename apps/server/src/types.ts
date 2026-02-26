export type PrepChunk = {
  id: string;
  text: string;
  embedding: number[];
};

export type TranscriptLine = {
  id: string;
  speaker: string;
  rawSpeaker: string;
  text: string;
  timestamp: number;
  isFinal: boolean;
};
