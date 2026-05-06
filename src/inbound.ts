// Inbound queue: Telegram free text → connected Claude session via the
// `@anthropic-ai/claude-agent-sdk` query() API.
//
// We only DRIVE the agent here (inject the user's text). Delivery back to
// Telegram is owned exclusively by the Stop hook → /stop intake path —
// every assistant turn ends with a Stop hook fire that carries the assistant
// text in-band, so external turns and bridge-driven turns share a single
// delivery channel. This module only surfaces failures.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";
import { bot, getActiveSessionId } from "./telegram.js";
import { shortSid } from "./format.js";
import { claudeBinaryPath } from "./sdkBinary.js";
import { createTelegramAttachServer } from "./telegramAttachTool.js";

// One MCP server instance shared across all bridge-driven turns. Lazy-init,
// not module-top-level: telegram.ts and inbound.ts form an import cycle (the
// bot handler enqueues, the queue invokes the bot), so reading `bot` at
// module evaluation time hits ESM's TDZ. By first-message time the cycle is
// fully resolved and `bot` is initialized.
let _telegramMcpServer: ReturnType<typeof createTelegramAttachServer> | null = null;
function getTelegramMcpServer() {
  if (!_telegramMcpServer) {
    _telegramMcpServer = createTelegramAttachServer(bot, config.allowedChatId);
  }
  return _telegramMcpServer;
}

export interface InboundJob {
  text: string;
  chatId: number;
  userMessageId: number;
  targetSessionId: string;
  targetCwd: string;
}

interface ClaudeResult {
  code: number;
  stderr: string;
}

// Content-shape guidance appended to Claude's default system prompt while a
// session is bridged to Telegram. Pure shape advice — never tells the model
// about Telegram's HTML / Markdown syntax (that's our converter's job).
const TELEGRAM_NUDGE = [
  "You are responding through a Telegram bridge — your output is rendered on a phone in a chat client.",
  "Format your replies for that medium:",
  "- Keep paragraphs short and scannable; favour 2–4 line paragraphs over long blocks of prose.",
  "- Wrap multi-line code, JSON, command output, file dumps, and any tabular data in fenced code blocks (```).",
  "- Avoid wide Markdown tables; convert them to short bullet lists or compact prose.",
  "- Skip long horizontal rules and ASCII art; they waste vertical space on a phone.",
  "- Use bold / italics / inline code sparingly, only for genuine emphasis.",
  "",
  "Sharing files: when a file (image, chart, screenshot, PDF, etc.) would be more useful to the user than a description, call the `telegram_send` tool with its absolute path. The file appears in Telegram immediately, in addition to your text reply.",
].join("\n");

const queue: InboundJob[] = [];
let running = false;

export function enqueueInbound(job: InboundJob): void {
  queue.push(job);
  console.log(
    `inbound: queued depth=${queue.length} sid=${shortSid(job.targetSessionId)}`,
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

async function runJob(job: InboundJob): Promise<void> {
  // Bail if the user disconnected or switched between enqueue and dequeue.
  const active = getActiveSessionId();
  if (active !== job.targetSessionId) {
    console.log(
      `inbound: drop stale sid=${shortSid(job.targetSessionId)} (active=${active ? shortSid(active) : "-"})`,
    );
    return;
  }

  console.log(
    `inbound: query sid=${shortSid(job.targetSessionId)} cwd=${job.targetCwd} bytes=${job.text.length}`,
  );

  // Show "typing…" indicator, refresh every 4s until claude finishes
  // (Telegram's typing action expires after 5s).
  await sendTyping(job.chatId);
  const typingInterval = setInterval(() => void sendTyping(job.chatId), 4000);

  let result: ClaudeResult;
  try {
    result = await runClaude(job);
  } finally {
    clearInterval(typingInterval);
  }

  if (result.code !== 0) {
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
  // On success: the Stop hook will deliver the reply via /stop. Nothing to do.
}

async function runClaude(job: InboundJob): Promise<ClaudeResult> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    config.claudeTimeoutSec * 1000,
  );

  let exitCode = 0;
  let stderr = "";
  let sdkStderr = "";

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
        // Pin the binary explicitly. The SDK's auto-picker prefers the musl
        // variant when both are on disk, even on glibc systems — see the
        // header comment in ./sdkBinary.ts for details.
        pathToClaudeCodeExecutable: claudeBinaryPath,
        // Append our Telegram-shape guidance to the default Claude Code system
        // prompt. Only added on bridge-driven turns — sessions driven directly
        // from the desktop client are unaffected.
        systemPrompt: { type: "preset", preset: "claude_code", append: TELEGRAM_NUDGE },
        // Register the in-process telegram_send tool so the agent can ship
        // files (charts, screenshots, generated artifacts) back as real
        // Telegram attachments. See ./telegramAttachTool.ts.
        mcpServers: { telegram: getTelegramMcpServer() },
        // Pipe the bundled CLI's stderr into our log surface — without this
        // the SDK silently discards it and any failure shows up as a bare
        // "claude exited -1" with no diagnostic text.
        stderr: (line: string) => { sdkStderr += line; },
      },
    });

    // Drain the iterator — we don't read its text (the Stop hook delivers
    // that), but we do need the `result` message to detect failures.
    for await (const msg of q) {
      if (msg.type === "result") {
        const r = msg as { subtype?: string; is_error?: boolean; errors?: string[] };
        if (r.subtype && r.subtype !== "success") {
          exitCode = -1;
          const detail = r.is_error ? (r.errors ?? []).join("; ") : "";
          stderr = `result subtype=${r.subtype}${detail ? ` — ${detail}` : ""}`;
        }
      }
    }
  } catch (e) {
    exitCode = -1;
    stderr = controller.signal.aborted
      ? `timeout after ${config.claudeTimeoutSec}s`
      : ((e as Error).stack ?? String(e));
  } finally {
    clearTimeout(timer);
  }

  if (exitCode !== 0) {
    console.error(
      `inbound: query failed sid=${shortSid(job.targetSessionId)} code=${exitCode} stderr=${stderr}` +
      (sdkStderr ? ` sdk_stderr=${sdkStderr.replace(/\s+/g, " ").slice(0, 1000)}` : ""),
    );
  } else if (sdkStderr) {
    // Surface anything the CLI wrote to stderr even on success (warnings).
    console.warn(
      `inbound: query ok sid=${shortSid(job.targetSessionId)} sdk_stderr=${sdkStderr.replace(/\s+/g, " ").slice(0, 500)}`,
    );
  }

  return { code: exitCode, stderr };
}
