// Inbound queue: Telegram free text → connected Claude session via the
// `@anthropic-ai/claude-agent-sdk` query() API. The response itself is NOT
// forwarded from here — it arrives back through the Stop hook → /stop →
// Telegram path, so external turns and bridge-driven turns share a single
// fan-in. This function only surfaces failures.

import { query } from "@anthropic-ai/claude-agent-sdk";
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

  const result = await runClaude(job);

  if (result.code === 0) {
    // Reply will arrive via the Stop hook. Nothing to do here.
    return;
  }

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
        for (const b of content) {
          if (b.type === "text" && typeof b.text === "string") {
            assistantText += b.text;
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
