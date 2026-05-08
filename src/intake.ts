// HTTP intake server — Claude Code's Stop hook posts end-of-turn event JSON
// here. Forwards to Telegram only when the posted session matches the
// currently-connected one.
//
// Stop hook event shape (subset we care about):
//   { session_id, cwd, last_assistant_message, ... }
//
// `last_assistant_message` is added by Anthropic specifically to avoid the
// JSONL-flush race that would otherwise force us to slurp the transcript file.
//
// All code paths log INFO so a missing message has a breadcrumb trail.

import http from "node:http";
import path from "node:path";
import os from "node:os";
import { config } from "./config.js";
import { getActiveSessionId, sendAgentReply } from "./telegram.js";
import { getLatestAssistantUuid } from "./sessions.js";
import { shortSid } from "./format.js";

const HOST = "127.0.0.1";
const HOME = os.homedir();

interface StopEvent {
  session_id?: string;
  cwd?: string;
  last_assistant_message?: string;
}

function projectShortname(cwd: string): string {
  if (!cwd) return "";
  if (cwd === HOME) return "~";
  return path.basename(cwd);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, code: number, payload: object): void {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": body.byteLength,
  });
  res.end(body);
}

export function startIntake(): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        send(res, 200, { ok: true });
        return;
      }
      if (req.method !== "POST" || req.url !== "/stop") {
        send(res, 404, { ok: false, error: "not found" });
        return;
      }

      let event: StopEvent;
      try {
        event = JSON.parse(await readBody(req)) as StopEvent;
      } catch (e) {
        console.warn(`intake: bad json: ${(e as Error).message}`);
        send(res, 400, { ok: false, error: "bad json" });
        return;
      }

      const sessionId = (event.session_id ?? "").trim();
      const text = (event.last_assistant_message ?? "").trim();
      const project = projectShortname((event.cwd ?? "").trim());

      if (!sessionId) {
        console.warn("intake: missing session_id");
        send(res, 400, { ok: false, error: "missing session_id" });
        return;
      }

      const active = getActiveSessionId();
      if (!active || active !== sessionId) {
        console.log(
          `intake: drop sid=${shortSid(sessionId)} (active=${active ? shortSid(active) : "-"})`
        );
        send(res, 202, { ok: true, forwarded: false, reason: "not connected" });
        return;
      }

      if (!text) {
        console.log(`intake: empty text sid=${shortSid(sessionId)}`);
        send(res, 202, { ok: true, forwarded: false, reason: "empty text" });
        return;
      }

      try {
        // Resolve the turn's anchor uuid from the on-disk JSONL — the Stop
        // hook fires AFTER the assistant entry is written, so the latest
        // assistant uuid in the transcript IS the one belonging to this
        // turn. Each chunk we send back gets stamped with that anchor so
        // a later reply-as-rewind can use it. Best-effort: if the lookup
        // fails for any reason, the chunks just store legacy-shape routes
        // (reply still routes the right session, just no rewind anchor).
        const anchorUuid = await getLatestAssistantUuid(sessionId).catch(() => null);
        await sendAgentReply(sessionId, project, text, anchorUuid);
        console.log(`intake: forwarded sid=${shortSid(sessionId)} bytes=${text.length}`);
        send(res, 202, { ok: true, forwarded: true });
      } catch (e) {
        console.error(`intake: forward failed sid=${shortSid(sessionId)}: ${(e as Error).message}`);
        send(res, 500, { ok: false, error: "forward failed" });
      }
    } catch (e) {
      console.error(`intake: handler crashed: ${(e as Error).stack ?? e}`);
      try { send(res, 500, { ok: false, error: "internal" }); } catch { /* ignore */ }
    }
  });

  server.listen(config.intakePort, HOST, () => {
    console.log(`intake listening on http://${HOST}:${config.intakePort}`);
  });
  return server;
}
