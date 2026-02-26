import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import type { RawData, WebSocket } from "ws";
import { generateAssist } from "./openai-service.js";
import { memoryStore } from "./store.js";
import { retrieveRelevantChunks } from "./vector-search.js";

type WsMessage = {
  type: string;
  payload?: unknown;
};

type TriggerReason =
  | "auto_fast_question"
  | "auto_turn_complete"
  | "auto_delayed_settle"
  | "manual";

function getDeepgramClient() {
  const deepgramApiKey = process.env.DEEPGRAM_API_KEY?.trim();
  if (!deepgramApiKey) {
    throw new Error("DEEPGRAM_API_KEY is required");
  }
  return createClient(deepgramApiKey);
}

function send(ws: WebSocket, message: WsMessage) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(message));
  }
}

function looksLikeQuestion(text: string): boolean {
  const lower = text.toLowerCase().trim();
  if (!lower) return false;
  if (lower.endsWith("?")) return true;
  if (/^(what|why|how|when|where|who|which|could|can|would|do|did|are|is)\b/.test(lower)) return true;
  if (/(tell me|introduce yourself|walk me through|share an example|describe|explain)\b/.test(lower)) return true;
  return false;
}

function isLikelyIncompleteTurn(text: string): boolean {
  const trimmed = text.toLowerCase().trim();
  if (!trimmed) return true;
  if (/[,:;]$/.test(trimmed)) return true;
  if (/\b(and|or|but|so|because|then|that|which|you|your|to|for|with|about|like|if|when|while|as|of)$/.test(trimmed)) {
    return true;
  }
  return false;
}

function shouldTriggerAssistForTurn(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return false;

  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  const lower = normalized.toLowerCase();
  const endsLikeComplete = /[.!?]["']?$/.test(normalized);
  const startsLikeQuestion = /^(what|why|how|when|where|who|which|could|can|would|do|did|are|is)\b/.test(lower);
  const hasQuestionMark = normalized.includes("?");
  const explicitQuestion = looksLikeQuestion(normalized);

  if (!explicitQuestion && wordCount < 7) return false;
  if (explicitQuestion && wordCount < 3) return false;
  if (isLikelyIncompleteTurn(normalized)) return false;
  if (/(\buh\b|\bum\b|\byou know\b|\blike\b)\s*[,.!?]*$/i.test(lower)) return false;
  if (/^(so|well|alright|okay|right)\b[,. ]*$/i.test(lower)) return false;

  const requestLike = /(tell me|walk me through|share an example|describe|explain|introduce yourself)\b/.test(lower);
  if (!explicitQuestion && !(requestLike && wordCount >= 10)) return false;
  if (explicitQuestion && (hasQuestionMark || startsLikeQuestion) && wordCount >= 3) return true;
  if (!endsLikeComplete && !startsLikeQuestion && wordCount < 12) return false;
  return true;
}

function shouldUseTurnForAssist(speaker: string, selfSpeaker: string): boolean {
  return speaker !== selfSpeaker;
}

function questionConfidence(text: string): number {
  const normalized = text.replace(/\s+/g, " ").trim();
  const lower = normalized.toLowerCase();
  const words = normalized.split(/\s+/).filter(Boolean).length;
  let score = 0.35;

  if (/\?/.test(normalized)) score += 0.25;
  if (/^(what|why|how|when|where|who|which|could|can|would|do|did|are|is)\b/.test(lower)) score += 0.2;
  if (/(tell me|walk me through|share an example|describe|explain|introduce yourself)\b/.test(lower)) score += 0.15;
  if (words >= 8) score += 0.05;
  if (isLikelyIncompleteTurn(normalized)) score -= 0.15;
  if (/(\buh\b|\bum\b|\byou know\b|\blike)\s*[,.!?]*$/i.test(lower)) score -= 0.1;

  return Math.max(0, Math.min(1, score));
}

function chooseTriggerDelayMs(text: string): number {
  const normalized = text.replace(/\s+/g, " ").trim();
  const words = normalized.split(/\s+/).filter(Boolean).length;
  const hasQuestionMark = normalized.includes("?");
  const clearQuestionStart = /^(what|why|how|when|where|who|which|could|can|would|do|did|are|is)\b/i.test(normalized);

  if (hasQuestionMark && words >= 4) return 1300;
  if (clearQuestionStart && words >= 4) return 1600;
  if (looksLikeQuestion(normalized)) return 1900;
  return 2400;
}

export function setupDeepgramSession(ws: WebSocket) {
  const speakerMap = new Map<string, string>();
  let speakerCounter = 0;
  let audioChunkCount = 0;
  let transcriptCount = 0;
  let selfSpeaker = "Speaker 1";
  let assistCooldownUntil = 0;
  let pendingTurnTimer: NodeJS.Timeout | null = null;
  let pendingTurnSpeaker = "";
  let pendingTurnText = "";
  let pendingTurnTs = 0;
  let pendingTurnStartTs = 0;
  let lastUtteranceEndAt = 0;
  let lastAssistFingerprint = "";
  let lastAssistAt = 0;

  const dg = getDeepgramClient().listen.live({
    model: "nova-2",
    language: "en-US",
    interim_results: true,
    smart_format: true,
    diarize: true,
    utterance_end_ms: 1000,
    punctuate: true,
    encoding: "linear16",
    sample_rate: 16000,
    channels: 1
  });

  dg.on(LiveTranscriptionEvents.Open, () => send(ws, { type: "status", payload: { message: "Deepgram connected" } }));
  dg.on(LiveTranscriptionEvents.Close, () => send(ws, { type: "status", payload: { message: "Deepgram connection closed" } }));
  dg.on(LiveTranscriptionEvents.Error, (error) =>
    send(ws, { type: "status", payload: { message: `Deepgram error: ${JSON.stringify(error)}` } })
  );
  dg.on(LiveTranscriptionEvents.UtteranceEnd, () => {
    lastUtteranceEndAt = Date.now();
  });

  dg.on(LiveTranscriptionEvents.Transcript, async (event) => {
    const alt = event.channel?.alternatives?.[0];
    const transcript = alt?.transcript?.trim();
    if (!transcript) return;

    const rawSpeaker = alt.words?.[0]?.speaker?.toString() ?? "unknown";
    if (!speakerMap.has(rawSpeaker) && speakerCounter < 4) {
      speakerCounter += 1;
      speakerMap.set(rawSpeaker, `Speaker ${speakerCounter}`);
    }

    const speaker = speakerMap.get(rawSpeaker) ?? "Speaker 4";
    const line = {
      id: `${rawSpeaker}-${event.start}-${event.duration}`,
      speaker,
      rawSpeaker,
      text: transcript,
      timestamp: Date.now(),
      isFinal: Boolean(event.is_final)
    };

    transcriptCount += 1;
    if (transcriptCount % 10 === 1) {
      send(ws, { type: "status", payload: { message: `Receiving transcript (${transcriptCount})` } });
    }

    memoryStore.pushTranscript(line);
    send(ws, { type: "transcript", payload: line });

    const shouldAutoAssist =
      line.isFinal && line.speaker !== selfSpeaker && transcript.split(" ").length > 2 && Date.now() > assistCooldownUntil;

    if (!shouldAutoAssist) return;

    const samePendingSpeaker = pendingTurnSpeaker === line.speaker;
    const closeInTime = Date.now() - pendingTurnTs < 3500;
    if (!samePendingSpeaker || !closeInTime) {
      pendingTurnText = line.text;
      pendingTurnStartTs = Date.now();
    } else {
      const needsSpace = !pendingTurnText.endsWith(" ") && !line.text.startsWith(" ");
      pendingTurnText = `${pendingTurnText}${needsSpace ? " " : ""}${line.text}`.trim();
    }
    pendingTurnSpeaker = line.speaker;
    pendingTurnTs = Date.now();

    if (pendingTurnTimer) clearTimeout(pendingTurnTimer);
    const waitMs = chooseTriggerDelayMs(pendingTurnText);

    pendingTurnTimer = setTimeout(async () => {
      const finalTurn = pendingTurnText.trim();
      const finalSpeaker = pendingTurnSpeaker;
      const finalTurnAge = Date.now() - pendingTurnStartTs;
      const sinceUtteranceEnd = Date.now() - lastUtteranceEndAt;

      if (sinceUtteranceEnd < 900 && finalTurnAge < 20_000) {
        pendingTurnTimer = setTimeout(async () => {
          if (!pendingTurnText.trim()) return;
          const turn = pendingTurnText.trim();
          const speaker = pendingTurnSpeaker;

          pendingTurnText = "";
          pendingTurnSpeaker = "";
          pendingTurnTs = 0;
          pendingTurnStartTs = 0;
          pendingTurnTimer = null;

          if (!turn || !shouldTriggerAssistForTurn(turn) || !shouldUseTurnForAssist(speaker, selfSpeaker)) return;

          const fingerprint = turn.toLowerCase().replace(/\s+/g, " ").trim();
          if (fingerprint === lastAssistFingerprint && Date.now() - lastAssistAt < 12_000) return;

          lastAssistFingerprint = fingerprint;
          lastAssistAt = Date.now();
          assistCooldownUntil = Date.now() + 2000;

          const confidence = questionConfidence(turn);
          send(ws, { type: "status", payload: { message: "Generating AI answer..." } });
          send(ws, { type: "trigger", payload: { reason: "auto_delayed_settle", speaker, text: turn, confidence } });
          await generateAndSendAssist(ws, selfSpeaker, turn, speaker, "auto_delayed_settle", confidence);
        }, 1000);
        return;
      }

      pendingTurnText = "";
      pendingTurnSpeaker = "";
      pendingTurnTs = 0;
      pendingTurnStartTs = 0;
      pendingTurnTimer = null;

      if (!finalTurn || !shouldTriggerAssistForTurn(finalTurn) || !shouldUseTurnForAssist(finalSpeaker, selfSpeaker)) {
        return;
      }

      const fingerprint = finalTurn.toLowerCase().replace(/\s+/g, " ").trim();
      if (fingerprint === lastAssistFingerprint && Date.now() - lastAssistAt < 12_000) return;

      lastAssistFingerprint = fingerprint;
      lastAssistAt = Date.now();
      assistCooldownUntil = Date.now() + 2000;

      const reason: TriggerReason =
        finalTurn.includes("?") || /^(what|why|how|when|where|who|which|could|can|would|do|did|are|is)\b/i.test(finalTurn)
          ? "auto_fast_question"
          : "auto_turn_complete";
      const confidence = questionConfidence(finalTurn);

      send(ws, { type: "status", payload: { message: "Generating AI answer..." } });
      send(ws, { type: "trigger", payload: { reason, speaker: finalSpeaker, text: finalTurn, confidence } });
      await generateAndSendAssist(ws, selfSpeaker, finalTurn, finalSpeaker, reason, confidence);
    }, waitMs);
  });

  const cleanup = () => {
    if (pendingTurnTimer) clearTimeout(pendingTurnTimer);
    pendingTurnText = "";
    pendingTurnSpeaker = "";
    pendingTurnTs = 0;
    pendingTurnStartTs = 0;
    try {
      dg.requestClose();
    } catch {
      // no-op
    }
  };

  ws.on("close", cleanup);
  ws.on("error", cleanup);

  ws.on("message", async (data: RawData, isBinary) => {
    if (isBinary) {
      audioChunkCount += 1;
      if (audioChunkCount === 1 || audioChunkCount % 40 === 0) {
        send(ws, { type: "status", payload: { message: `Audio streaming (${audioChunkCount} chunks)` } });
      }

      if (Buffer.isBuffer(data)) {
        const chunk = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        dg.send(chunk);
      } else if (data instanceof ArrayBuffer) {
        dg.send(data);
      }
      return;
    }

    try {
      const payload = JSON.parse(data.toString()) as { type?: string; selfSpeaker?: string };
      if (payload.type === "set_config" && payload.selfSpeaker) {
        selfSpeaker = payload.selfSpeaker;
        send(ws, { type: "status", payload: { message: `Self speaker set to ${selfSpeaker}` } });
      }
      if (payload.type === "generate_assist") {
        send(ws, { type: "trigger", payload: { reason: "manual", speaker: selfSpeaker, text: "", confidence: 1 } });
        await generateAndSendAssist(ws, selfSpeaker, undefined, undefined, "manual", 1);
      }
    } catch {
      // ignore malformed non-binary message
    }
  });
}

async function generateAndSendAssist(
  ws: WebSocket,
  selfSpeaker: string,
  forcedQuestion?: string,
  forcedSpeaker?: string,
  triggerReason: TriggerReason = "auto_turn_complete",
  triggerConfidence = 0.8
) {
  try {
    const startedAt = Date.now();
    const recent = memoryStore.getRecentTranscript(60_000);
    if (!recent.length) return;

    const contextLines = recent.filter((line) => line.speaker !== "AI");
    const interviewerOnly = contextLines.filter((line) => line.speaker !== selfSpeaker);
    const sourceLines = interviewerOnly.length ? interviewerOnly : contextLines;

    const interviewerQuestionLine = [...sourceLines].reverse().find((line) => looksLikeQuestion(line.text));
    const questionText = forcedQuestion ?? interviewerQuestionLine?.text ?? sourceLines[sourceLines.length - 1]?.text ?? "";
    if (!questionText) return;

    const foundSourceLine = forcedSpeaker ? contextLines.find((line) => line.speaker === forcedSpeaker) : undefined;
    const sourceLine = foundSourceLine ?? interviewerQuestionLine ?? sourceLines[sourceLines.length - 1];

    const recentText = contextLines.map((line) => `${line.speaker}: ${line.text}`).join("\n");

    let retrieved: string[] = [];
    try {
      retrieved = await retrieveRelevantChunks(questionText, 3);
    } catch {
      send(ws, { type: "status", payload: { message: "Prep retrieval failed, using conversation context..." } });
    }

    let answer = "";
    try {
      answer = await generateAssist({
        retrievedChunks: retrieved,
        recentTranscript: recentText,
        interviewerQuestion: questionText
      });
    } catch {
      answer = "I would answer by clearly addressing the question and tying it to one relevant project outcome.";
    }

    send(ws, {
      type: "assist",
      payload: {
        answer,
        generatedAt: new Date().toISOString(),
        sourceLineId: sourceLine?.id ?? "",
        sourceSpeaker: sourceLine?.speaker ?? "",
        sourceText: sourceLine?.text ?? "",
        triggerReason,
        questionConfidence: triggerConfidence,
        responseMs: Date.now() - startedAt,
        questionText
      }
    });
  } catch {
    send(ws, { type: "status", payload: { message: "AI answer pipeline failed. Retrying on next question." } });
  }
}
