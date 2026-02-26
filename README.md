# SpeakMate

Real-time interview and meeting copilot built with **Next.js + Node.js + Deepgram + OpenAI**.

SpeakMate captures live microphone audio, transcribes in near real time with speaker labeling, and generates contextual AI response suggestions grounded in uploaded prep material (resume, notes, PDFs).

## Features

- Live microphone streaming from browser to backend WebSocket
- Deepgram real-time transcription with diarization (`Speaker 1..4`)
- Prep material upload (`.pdf`, `.txt`, `.md`) and in-memory indexing
- Vector retrieval over prep chunks using OpenAI embeddings
- Auto AI assist trigger on interviewer question turns
- Manual assist trigger (`Ctrl/Cmd + Enter`)
- Chat-style transcript UI with:
  - auto-scroll anchored near top for better posture/use
  - hidden self transcript view (still captured server-side)
  - trigger diagnostics and response stats

## Tech Stack

- Frontend: Next.js (App Router), React, TypeScript
- Backend: Express, WebSocket (`ws`), TypeScript
- Transcription: Deepgram live API
- LLM + Embeddings: OpenAI API
- Storage (MVP): in-memory

## Monorepo Layout

```txt
.
├── apps/
│   ├── server/
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── deepgram-service.ts
│   │   │   ├── openai-service.ts
│   │   │   ├── prep-service.ts
│   │   │   ├── vector-search.ts
│   │   │   ├── chunking.ts
│   │   │   ├── store.ts
│   │   │   └── types.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── web/
│       ├── app/
│       │   ├── layout.tsx
│       │   ├── page.tsx
│       │   └── globals.css
│       ├── components/
│       │   └── meet-speak-app.tsx
│       ├── package.json
│       └── next.config.ts
├── package.json
└── .env.example
```

## Prerequisites

- Node.js 18+
- npm 9+
- Deepgram API key
- OpenAI API key

## Environment Variables

Copy and edit:

```bash
cp .env.example .env
```

Required values:

- `OPENAI_API_KEY`
- `DEEPGRAM_API_KEY`
- `PORT` (default `8000`)
- `NEXT_PUBLIC_API_BASE` (default `http://localhost:8000`)
- `NEXT_PUBLIC_WS_URL` (default `ws://localhost:8000/ws/transcribe`)

## Install

```bash
npm install
```

## Run (Dev)

```bash
npm run dev
```

- Frontend: `http://localhost:3000`
- Backend: `http://localhost:8000`
- Health: `GET /health`

## Build

```bash
npm run build
```

## How It Works

1. Browser captures mic audio and sends PCM chunks to backend WS.
2. Backend streams audio to Deepgram live transcription.
3. Deepgram emits transcript chunks + speaker IDs.
4. Backend maps speakers (`Speaker 1..4`), stores rolling transcript.
5. On question-like completed turns, backend triggers AI assist:
   - gets recent conversation context
   - retrieves relevant prep chunks by embedding similarity
   - calls OpenAI for a natural interview-ready response
6. Frontend renders transcript and inline AI responses in real time.

## Notes

- MVP intentionally uses in-memory storage (no DB).
- No auth is enforced in this version.
- Uploaded prep files are indexed; only chunks/embeddings are retained in memory.
- UI hides your own transcript lines for stealth mode, but backend still processes/stores them.

## Security

- Never commit real API keys.
- Keep `.env` local only.
- Rotate keys immediately if exposed.

## Troubleshooting

- **No transcription appears**
  - Confirm browser mic permission is granted.
  - Check `DEEPGRAM_API_KEY` is valid.
- **Server crashes on startup**
  - Verify `.env` exists and contains required keys.
- **AI not answering**
  - Check `OPENAI_API_KEY` and backend logs.
  - Use manual assist (`Ctrl/Cmd + Enter`) to test pipeline.

## License

Private/internal use unless explicitly relicensed.
