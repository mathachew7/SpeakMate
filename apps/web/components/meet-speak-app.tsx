"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type TranscriptLine = {
  id: string;
  speaker: string;
  text: string;
  timestamp: number;
  isFinal: boolean;
};

type TriggerReason = "auto_fast_question" | "auto_turn_complete" | "auto_delayed_settle" | "manual";

type AssistPayload = {
  answer: string;
  generatedAt: string;
  sourceLineId?: string;
  sourceSpeaker?: string;
  sourceText?: string;
  questionText?: string;
  triggerReason?: TriggerReason;
  questionConfidence?: number;
  responseMs?: number;
};

type TriggerEvent = {
  reason: TriggerReason;
  speaker: string;
  text: string;
  confidence: number;
};

type SpeakerProfile = { name: string; role: string; tone: string; badge: string };

type PrepAsset = { name: string; status: string; kind: string };

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";
const WS_BASE = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000/ws/transcribe";
const SPEAKER_ORDER = ["Speaker 1", "Speaker 2", "Speaker 3", "Speaker 4"] as const;

function speakerNumber(label: string): number {
  const match = label.match(/Speaker\s+(\d+)/i);
  return match ? Number(match[1]) : 0;
}

function looksQuestionText(text: string): boolean {
  const lower = text.toLowerCase().trim();
  if (!lower) return false;
  return (
    lower.includes("?") ||
    /^(what|why|how|when|where|who|which|could|can|would|do|did|are|is)\b/.test(lower) ||
    /(tell me|walk me through|share an example|describe|explain|introduce yourself)\b/.test(lower)
  );
}

function profileForSpeaker(label: string, selfSpeaker: string): SpeakerProfile {
  if (label === "AI") return { name: "AI", role: "Assistant", tone: "manager", badge: "AI" };
  if (label === selfSpeaker) return { name: "You", role: "Candidate", tone: "you", badge: "YOU" };
  const num = speakerNumber(label);
  if (num > 0) return { name: `Interviewer ${num}`, role: "Team Member", tone: num % 2 ? "product" : "manager", badge: `I${num}` };
  return { name: label, role: "Participant", tone: "guest", badge: label.slice(0, 2).toUpperCase() };
}

function mergeBySpeaker(lines: TranscriptLine[]): TranscriptLine[] {
  if (!lines.length) return [];
  const merged: TranscriptLine[] = [];
  for (const line of lines) {
    const prev = merged[merged.length - 1];
    if (!prev || prev.speaker !== line.speaker || prev.speaker === "AI" || line.speaker === "AI") {
      merged.push({ ...line });
      continue;
    }
    const needsSpace = !prev.text.endsWith(" ") && !line.text.startsWith(" ");
    prev.text = `${prev.text}${needsSpace ? " " : ""}${line.text}`.trim();
    prev.timestamp = line.timestamp;
    prev.id = `${prev.id}__${line.id}`;
    prev.isFinal = prev.isFinal && line.isFinal;
  }
  return merged;
}

export function SpeakMateApp() {
  const wsRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const activeLineRef = useRef<HTMLElement | null>(null);
  const autoStartRef = useRef(false);

  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [assistHistory, setAssistHistory] = useState<AssistPayload[]>([]);
  const [lastTrigger, setLastTrigger] = useState<TriggerEvent | null>(null);
  const [status, setStatus] = useState("Idle");
  const [uploadStatus, setUploadStatus] = useState("No prep material uploaded");
  const [isLive, setIsLive] = useState(false);
  const [prepAssets, setPrepAssets] = useState<PrepAsset[]>([]);
  const [selfSpeaker, setSelfSpeaker] = useState<string>("Speaker 1");
  const [meetingTitle, setMeetingTitle] = useState("Senior Product Engineer Interview");
  const [meetingGoal, setMeetingGoal] = useState(
    "Show leadership in incident management, system reliability, and cross-functional communication."
  );

  const displayTranscript = useMemo(
    () => mergeBySpeaker(transcript.filter((line) => line.isFinal).slice(-260)).slice(-90),
    [transcript]
  );
  const visibleTranscript = useMemo(
    () => displayTranscript.filter((line) => line.speaker !== selfSpeaker),
    [displayTranscript, selfSpeaker]
  );

  const observedSpeakers = useMemo(() => {
    const fromTranscript = Array.from(new Set(displayTranscript.map((line) => line.speaker)));
    return Array.from(new Set([...SPEAKER_ORDER, ...fromTranscript])).slice(0, 4);
  }, [displayTranscript]);

  const chatStats = useMemo(() => {
    const nonAi = displayTranscript.filter((x) => x.speaker !== "AI");
    const questions = nonAi.filter((x) => x.speaker !== selfSpeaker && looksQuestionText(x.text));
    const yourTurns = nonAi.filter((x) => x.speaker === selfSpeaker);
    const yourWords = yourTurns.reduce((acc, line) => acc + line.text.split(/\s+/).filter(Boolean).length, 0);
    const readiness = questions.length ? Math.min(100, Math.round((assistHistory.length / questions.length) * 100)) : 100;
    return {
      questions: questions.length,
      aiAnswers: assistHistory.length,
      yourTurns: yourTurns.length,
      yourWords,
      readiness
    };
  }, [assistHistory.length, displayTranscript, selfSpeaker]);

  const latestAssist = assistHistory[assistHistory.length - 1];
  const avgResponseMs = useMemo(() => {
    const samples = assistHistory.map((x) => x.responseMs).filter((v): v is number => typeof v === "number" && v > 0);
    if (!samples.length) return 0;
    return Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
  }, [assistHistory]);

  useEffect(() => {
    if (!visibleTranscript.length || !isLive) return;
    requestAnimationFrame(() => {
      activeLineRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  }, [visibleTranscript.length, isLive]);

  useEffect(() => {
    if (autoStartRef.current) return;
    autoStartRef.current = true;
    void connectStream();
  }, []);

  const uploadPrep = async (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    setUploadStatus("Uploading prep material...");
    const res = await fetch(`${API_BASE}/api/prep/upload`, { method: "POST", body: formData });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? "Upload failed");
    }
    const data = await res.json();
    setUploadStatus(`Prep loaded: ${data.chunksStored} chunks indexed`);
    setPrepAssets((prev) => [
      { name: file.name, status: "Indexed", kind: file.name.toLowerCase().includes("resume") ? "Resume" : "Prep" },
      ...prev
    ]);
  };

  const triggerAssistNow = () => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "generate_assist" }));
    setStatus("Manual assist requested...");
  };

  const connectStream = async () => {
    if (isLive) return;
    try {
      setStatus("Requesting microphone access...");
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });

      setStatus("Connecting to transcription service...");
      const ws = new WebSocket(WS_BASE);
      ws.binaryType = "arraybuffer";
      ws.onclose = () => setStatus("Disconnected");
      ws.onerror = () => setStatus("WebSocket error");

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as { type: string; payload: any };
          if (msg.type === "transcript") {
            const line = msg.payload as TranscriptLine;
            setTranscript((prev) => [...prev.filter((x) => x.id !== line.id), line].sort((a, b) => a.timestamp - b.timestamp).slice(-220));
            return;
          }
          if (msg.type === "assist") {
            const payload = msg.payload as AssistPayload;
            setAssistHistory((prev) => {
              const already = prev.some((x) => x.sourceLineId && x.sourceLineId === payload.sourceLineId && x.answer === payload.answer);
              if (already) return prev;
              return [...prev, payload].slice(-60);
            });
            if (payload.answer?.trim()) {
              setTranscript((prev) => {
                const aiLine: TranscriptLine = {
                  id: `ai-${payload.generatedAt}-${payload.sourceLineId ?? "x"}`,
                  speaker: "AI",
                  text: payload.answer.trim(),
                  timestamp: Date.now(),
                  isFinal: true
                };
                if (prev.some((x) => x.id === aiLine.id)) return prev;
                return [...prev, aiLine].slice(-220);
              });
            }
            return;
          }
          if (msg.type === "trigger") {
            setLastTrigger(msg.payload as TriggerEvent);
            return;
          }
          if (msg.type === "status") setStatus(msg.payload.message ?? "Running");
        } catch {
          // no-op
        }
      };

      ws.onopen = () => {
        setStatus("Connected: listening");
        ws.send(JSON.stringify({ type: "set_config", selfSpeaker }));
      };

      const audioContext = new AudioContext({ sampleRate: 16000 });
      await audioContext.resume();
      const source = audioContext.createMediaStreamSource(mediaStream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);

      processor.onaudioprocess = (event) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const input = event.inputBuffer.getChannelData(0);
        const pcm = new Int16Array(input.length);
        for (let i = 0; i < input.length; i += 1) {
          const sample = Math.max(-1, Math.min(1, input[i]));
          pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        }
        ws.send(pcm.buffer);
      };

      source.connect(processor);
      processor.connect(audioContext.destination);

      mediaStreamRef.current = mediaStream;
      audioContextRef.current = audioContext;
      sourceNodeRef.current = source;
      processorRef.current = processor;
      wsRef.current = ws;
      setIsLive(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Microphone access failed";
      setStatus(`Mic error: ${message}`);
      setIsLive(false);
    }
  };

  const stopStream = () => {
    processorRef.current?.disconnect();
    sourceNodeRef.current?.disconnect();
    processorRef.current = null;
    sourceNodeRef.current = null;
    audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    wsRef.current?.close();
    wsRef.current = null;
    setIsLive(false);
    setStatus("Stopped");
  };

  useEffect(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: "set_config", selfSpeaker }));
  }, [selfSpeaker]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        triggerAssistNow();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <main className="dash-shell">
      <aside className="left-rail panel">
        <div className="brand-block">
          <div className="brand-mark">SM</div>
          <div>
            <h1>SpeakMate</h1>
            <p>Interview Copilot Dashboard</p>
          </div>
        </div>

        <div className="panel-section">
          <span className="section-title">Meeting Setup</span>
          <label className="field-label">Meeting Name</label>
          <input className="field-input" value={meetingTitle} onChange={(e) => setMeetingTitle(e.target.value)} />
          <label className="field-label">Goal</label>
          <textarea className="field-input area" value={meetingGoal} onChange={(e) => setMeetingGoal(e.target.value)} />
        </div>

        <div className="panel-section">
          <span className="section-title">Prep Materials</span>
          <label className="upload-btn left-upload">
            Add Resume / Prep
            <input
              type="file"
              accept=".pdf,.txt,.md"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                try {
                  await uploadPrep(file);
                } catch (error) {
                  setUploadStatus((error as Error).message);
                }
              }}
            />
          </label>
          <p className="tiny-note">{uploadStatus}</p>
          <ul className="prep-list">
            {prepAssets.length === 0 ? (
              <li>
                <div>
                  <strong>No files indexed yet</strong>
                  <p>Upload resume or prep material to index.</p>
                </div>
              </li>
            ) : (
              prepAssets.map((item) => (
                <li key={`${item.name}-${item.kind}`}>
                  <div>
                    <strong>{item.name}</strong>
                    <p>{item.kind}</p>
                  </div>
                  <span>{item.status}</span>
                </li>
              ))
            )}
          </ul>
        </div>

        <div className="panel-section">
          <span className="section-title">Speaker Mapping</span>
          <label className="field-label">My voice appears as</label>
          <select className="field-input" value={selfSpeaker} onChange={(e) => setSelfSpeaker(e.target.value)}>
            {observedSpeakers.map((speaker) => (
              <option key={speaker} value={speaker}>
                {speaker}
              </option>
            ))}
          </select>
        </div>
      </aside>

      <section className="center-stage">
        <header className="panel control-bar">
          <div>
            <h2>{meetingTitle}</h2>
            <p>{meetingGoal}</p>
          </div>
          <div className="status-wrap">
            <span className={`status-pill ${isLive ? "ok" : "idle"}`}>{status}</span>
            <span className="status-pill subtle">Context: 60s rolling memory</span>
          </div>
        </header>

        <section className="panel action-row">
          {!isLive ? (
            <button className="btn primary" onClick={connectStream}>
              Start Live Capture
            </button>
          ) : (
            <button className="btn danger" onClick={stopStream}>
              Stop Capture
            </button>
          )}
          <button className="btn ghost" onClick={triggerAssistNow} disabled={!isLive}>
            Assist Now (Ctrl/Cmd+Enter)
          </button>
        </section>

        <section className="panel transcript-panel">
          <div className="panel-head">
            <h3>Live Conversation</h3>
            <span>{visibleTranscript.length} turns</span>
          </div>

          <div className="chatbox">
            {!visibleTranscript.length && (
              <p className="empty-transcript">{isLive ? "Listening... start speaking." : "Start capture to begin transcription."}</p>
            )}
            {visibleTranscript.map((line, index) => {
              const profile = profileForSpeaker(line.speaker, selfSpeaker);
              const isLast = index === visibleTranscript.length - 1;
              return (
                <article
                  key={line.id}
                  className="transcript-line"
                  ref={
                    isLast
                      ? (node) => {
                          activeLineRef.current = node;
                        }
                      : null
                  }
                >
                  <div className="line-meta">
                    <span className={`avatar ${profile.tone}`}>{profile.badge}</span>
                    <strong>{profile.name}</strong>
                    <span>{profile.role}</span>
                  </div>
                  <p className="line-text">{line.text}</p>
                </article>
              );
            })}
          </div>
        </section>
      </section>

      <aside className="right-stack">
        <section className="panel">
          <div className="panel-head">
            <h3>Live Intelligence</h3>
            <span>{latestAssist ? "Active" : "Waiting"}</span>
          </div>
          <div className="stat-grid">
            <div>
              <span>Questions Caught</span>
              <strong>{chatStats.questions}</strong>
            </div>
            <div>
              <span>AI Answers</span>
              <strong>{chatStats.aiAnswers}</strong>
            </div>
            <div>
              <span>Your Turns</span>
              <strong>{chatStats.yourTurns}</strong>
            </div>
            <div>
              <span>Readiness</span>
              <strong>{chatStats.readiness}%</strong>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>Trigger Diagnostics</h3>
            <span>{lastTrigger ? "Updated" : "Pending"}</span>
          </div>
          <p className="tiny-note">
            Last trigger: <strong>{lastTrigger?.reason ?? "none"}</strong> | confidence{" "}
            <strong>{Math.round((lastTrigger?.confidence ?? 0) * 100)}%</strong>
          </p>
          <p className="tiny-note">
            Average response: <strong>{avgResponseMs ? `${avgResponseMs}ms` : "--"}</strong>
          </p>
          <p className="tiny-note">Latest question: {latestAssist?.questionText ?? latestAssist?.sourceText ?? "Waiting for question..."}</p>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>Participants</h3>
            <span>{observedSpeakers.length}</span>
          </div>
          <ul className="people-list">
            {observedSpeakers.map((speaker) => {
              const person = profileForSpeaker(speaker, selfSpeaker);
              return (
                <li key={speaker}>
                  <span className={`avatar ${person.tone}`}>{person.badge}</span>
                  <div>
                    <strong>{person.name}</strong>
                    <p>{speaker === selfSpeaker ? "Your Mic" : `${speaker} • ${person.role}`}</p>
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="tiny-note">
            Your spoken words: <strong>{chatStats.yourWords}</strong>
          </p>
        </section>
      </aside>
    </main>
  );
}
