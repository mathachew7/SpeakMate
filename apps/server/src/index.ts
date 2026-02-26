import dotenv from "dotenv";
import cors from "cors";
import express from "express";
import multer from "multer";
import { createServer } from "node:http";
import path from "node:path";
import { promises as fs } from "node:fs";
import { WebSocketServer } from "ws";
import { setupDeepgramSession } from "./deepgram-service.js";
import { indexPrepFile } from "./prep-service.js";

dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

const app = express();
const port = Number(process.env.PORT || 8000);

app.use(cors());
app.use(express.json({ limit: "4mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, app: "SpeakMate" });
});

const uploadDir = path.resolve(process.cwd(), "tmp_uploads");
await fs.mkdir(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir });

app.post("/api/prep/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "File required" });
      return;
    }

    const result = await indexPrepFile(req.file.path, req.file.originalname);
    await fs.unlink(req.file.path).catch(() => {});
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed";
    res.status(500).json({ error: message });
  }
});

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/ws/transcribe") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    setupDeepgramSession(ws);
  });
});

server.listen(port, () => {
  console.log(`SpeakMate server listening on http://localhost:${port}`);
});
