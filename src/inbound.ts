// Inbound queue: Telegram free text → connected Claude session via the
// `@anthropic-ai/claude-agent-sdk` query() API.
//
// For bridge-driven turns we forward the assistant reply DIRECTLY from here,
// using the SDK's own end-of-turn signal (the iterator finishing). This is
// race-free — we have the full assistant text in memory by the time the SDK
// says "done", so we don't need to round-trip through the JSONL transcript
// + Stop hook.
//
// The Stop hook → /stop path still exists for any turn that didn't originate
// from the bridge (e.g. a session being driven from agent-ui directly).
// `isBridgeHandling()` lets the intake suppress double-forwards while we own
// the turn.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { fmt, b, code } from "@grammyjs/parse-mode";
import path from "node:path";
import os from "node:os";
import { config } from "./config.js";
import { bot, getActiveSessionId } from "./telegram.js";
import { shortSid } from "./format.js";

interface InboundJob {
  text: string;
  chatId: number;
  userMessageId: number;
  targetSessionId: string;
  targetCwd: string;
}

const queue: InboundJob[] = [];
let running = false;

// Sessions for which the bridge is currently producing a reply (or just did).
// Stored as deadline timestamps: while Date.now() < deadline, intake should
// drop Stop-hook payloads to avoid double-forwarding. Using deadlines (not
// timers) avoids a race where a tail timer from job N fires mid-job N+1.
const suppressUntil = new Map<string, number>();
const RUN_GUARD_MS = 60 * 60 * 1000; // upper bound while a job is running
const TAIL_GUARD_MS = 8000;          // window to absorb the trailing Stop hook

function suppressFor(sid: string, ms: number): void {
  suppressUntil.set(sid, Date.now() + ms);
}

export function isBridgeHandling(sid: string): boolean {
  const until = suppressUntil.get(sid);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    suppressUntil.delete(sid);
    return false;
  }
  return true;
}

export function enqueueInbound(job: InboundJob): void {
  queue.push(job);
  console.log(
    `inbound: queued depth=${queue.length} sid=${shortSid(job.targetSessionId)}`
  );
  void drain();
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift()!;
      await runJob(job).catch((e) => {
        console.error(`inbound: worker error: ${(e as Error).stack ?? e}`);
      });
    }
  } finally {
    running = false;
  }
}

async function sendTyping(chatId: number): Promise<void> {
  try { await bot.api.sendChatAction(chatId, "typing"); } catch { /* ignore */ }
}

function projectLabel(cwd: string): string {
  return cwd === os.homedir() ? "~" : path.basename(cwd);
}

const BODY_CAP = 3500;

async function forwardReply(sessionId: string, projLabel: string, text: string): Promise<void> {
  const body = text.length <= BODY_CAP ? text : text.slice(0, BODY_CAP).trimEnd() + "\n…(truncated)";
  const msg = fmt`${b}${projLabel}${b} · ${code}${shortSid(sessionId)}${code}\n\n${body}`;
  await bot.api.sendMessage(config.allowedChatId, msg.text, {
    entities: msg.entities,
    link_preview_options: { is_disabled: true },
  });
}

async function runJob(job: InboundJob): Promise<void> {
  // Bail if the user disconnected or switched between enqueue and dequeue.
  const active = getActiveSessionId();
  if (active !== job.targetSessionId) {
    console.log(
      `inbound: drop stale sid=${shortSid(job.targetSessionId)} (active=${active ? shortSid(active) : "-"})`
    );
    return;
  }

  console.log(
    `inbound: query sid=${shortSid(job.targetSessionId)} cwd=${job.targetCwd} bytes=${job.text.length}`
  );

  // Suppress Stop-hook forwards for this sid for the entire run, then a tail
  // window past completion. The deadline-based suppression survives back-to-
  // back jobs: each phase pushes the deadline forward.
  suppressFor(job.targetSessionId, RUN_GUARD_MS);

  // Show "typing..." indicator, refresh every 4s until claude finishes.
  await sendTyping(job.chatId);
  const typingInterval = setInterval(() => void sendTyping(job.chatId), 4000);

  let result: ClaudeResult;
  try {
    result = await runClaude(job);
  } finally {
    clearInterval(typingInterval);
  }

  if (result.code === 0) {
    const reply = result.stdout.trim();
    if (reply) {
      try {
        await forwardReply(job.targetSessionId, projectLabel(job.targetCwd), reply);
        console.log(
          `inbound: forwarded sid=${shortSid(job.targetSessionId)} bytes=${reply.length}`
        );
      } catch (e) {
        console.error(
          `inbound: forward failed sid=${shortSid(job.targetSessionId)}: ${(e as Error).message}`
        );
      }
    } else {
      console.log(`inbound: empty reply sid=${shortSid(job.targetSessionId)}`);
    }
  } else {
    const errShort = result.stderr.length > 600
      ? result.stderr.slice(0, 600) + "…"
      : result.stderr;
    const message = `⚠️ claude exited ${result.code}\n${errShort || "(no stderr)"}`;
    try {
      await bot.api.sendMessage(job.chatId, message, {
        reply_parameters: { message_id: job.userMessageId },
      });
    } catch (e) {
      console.error(`inbound: failed to report error to telegram: ${(e as Error).message}`);
    }
  }

  // Tail window past completion to absorb the lagging Stop hook fire.
  suppressFor(job.targetSessionId, TAIL_GUARD_MS);
}

interface ClaudeResult { code: number; stdout: string; stderr: string; }

async function runClaude(job: InboundJob): Promise<ClaudeResult> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    config.claudeTimeoutSec * 1000,
  );

  let assistantText = "";
  let exitCode = 0;
  let stderr = "";

  try {
    const q = query({
      prompt: job.text,
      options: {
        resume: job.targetSessionId,
        cwd: job.targetCwd,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        abortController: controller,
        includePartialMessages: false,
      },
    });

    for await (const msg of q) {
      if (msg.type === "assistant") {
        const content = (msg as { message?: { content?: Array<{ type: string; text?: string }> } })
          .message?.content ?? [];
        for (const blk of content) {
          if (blk.type === "text" && typeof blk.text === "string") {
            assistantText += blk.text;
          }
        }
      } else if (msg.type === "result") {
        const subtype = (msg as { subtype?: string }).subtype;
        if (subtype && subtype !== "success") {
          exitCode = -1;
          stderr = `result subtype=${subtype}`;
        }
      }
    }
  } catch (e) {
    exitCode = -1;
    if (controller.signal.aborted) {
      stderr = `timeout after ${config.claudeTimeoutSec}s`;
    } else {
      stderr = (e as Error).stack ?? String(e);
    }
  } finally {
    clearTimeout(timer);
  }

  return { code: exitCode, stdout: assistantText, stderr };
}
