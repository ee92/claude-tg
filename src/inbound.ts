// Inbound queue: Telegram free text → connected Claude session via the
// `@anthropic-ai/claude-agent-sdk` query() API.
//
// We only DRIVE the agent here (inject the user's text). Delivery back to
// Telegram is owned exclusively by the Stop hook → /stop intake path —
// every assistant turn ends with a Stop hook fire that carries the assistant
// text in-band, so external turns and bridge-driven turns share a single
// delivery channel. This module only surfaces failures.

import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";
import { bot, getActiveSessionId, setActiveSession, sendAgentReply } from "./telegram.js";
import { shortSid, formatTokens } from "./format.js";
import { claudeBinaryPath } from "./sdkBinary.js";
import { createTelegramAttachServer } from "./telegramAttachTool.js";

// Sentinel text on an InboundJob that triggers a /compact run rather than a
// normal turn. Routed through the same queue so it serializes behind any
// in-flight reply instead of interrupting it.
const COMPACT_SENTINEL = "/compact";

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

// `targetSessionId === null` flags a new-session job: query() runs without
// `resume`, the SDK assigns a fresh session id, and the bridge captures it
// from the first stream message and connects to it.
export interface InboundJob {
  text: string;
  chatId: number;
  userMessageId: number;
  targetSessionId: string | null;
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

// In-flight job's abort controller, exposed via cancelActive(). Set on entry
// to each run* function, cleared in finally. Null when the worker is idle.
let activeAbort: AbortController | null = null;

export function enqueueInbound(job: InboundJob): void {
  queue.push(job);
  const label = job.targetSessionId ? shortSid(job.targetSessionId) : "new";
  console.log(`inbound: queued depth=${queue.length} sid=${label}`);
  void drain();
}

// Cancel the currently-running turn (if any) and discard everything still
// queued behind it. Returns counts so the caller can render a precise notice.
// Idempotent — safe to call when the queue is idle.
export function cancelActive(): { cancelledInFlight: boolean; queueDrained: number } {
  const queueDrained = queue.length;
  queue.length = 0;
  let cancelledInFlight = false;
  if (activeAbort) {
    activeAbort.abort("user-cancel");
    cancelledInFlight = true;
  }
  return { cancelledInFlight, queueDrained };
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
  // New-session jobs run before any session id exists — skip the stale check
  // and fork to the dedicated path that captures the SDK-assigned id.
  if (job.targetSessionId === null) {
    return runNewSessionJob(job);
  }

  // Bail if the user disconnected or switched between enqueue and dequeue.
  const active = getActiveSessionId();
  if (active !== job.targetSessionId) {
    console.log(
      `inbound: drop stale sid=${shortSid(job.targetSessionId)} (active=${active ? shortSid(active) : "-"})`,
    );
    return;
  }

  if (job.text === COMPACT_SENTINEL) {
    return runCompactJob(job as InboundJob & { targetSessionId: string });
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
    result = await runClaude(job as InboundJob & { targetSessionId: string });
  } finally {
    clearInterval(typingInterval);
  }

  if (result.code !== 0 && result.stderr !== "cancelled") {
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
  // On user-cancel: the /cancel handler already informed the user.
}

async function runClaude(job: InboundJob & { targetSessionId: string }): Promise<ClaudeResult> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    config.claudeTimeoutSec * 1000,
  );
  activeAbort = controller;

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

    // Drain the iterator. Two interesting message kinds:
    //   - `result` — needed to detect failures.
    //   - `system / local_command_output` — emitted when the prompt was a
    //     local slash command (/cost, /context, /usage, …). Pure-local
    //     commands produce no assistant text, so the Stop hook's
    //     last_assistant_message is empty and intake silently drops it;
    //     without an explicit forward here, the user never sees the output.
    //     For commands that DO invoke the agent, both this output and the
    //     assistant text reach Telegram (this path + Stop hook), in order.
    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "local_command_output") {
        const content = (msg as { content?: string }).content?.trim();
        if (content) {
          try {
            const project = path.basename(job.targetCwd) || job.targetCwd;
            await sendAgentReply(job.targetSessionId, project, content);
          } catch (e) {
            console.warn(
              `inbound: local_command_output forward failed sid=${shortSid(job.targetSessionId)}: ${(e as Error).message}`,
            );
          }
        }
        continue;
      }
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
    if (controller.signal.aborted) {
      stderr = controller.signal.reason === "user-cancel"
        ? "cancelled"
        : `timeout after ${config.claudeTimeoutSec}s`;
    } else {
      stderr = (e as Error).stack ?? String(e);
    }
  } finally {
    clearTimeout(timer);
    if (activeAbort === controller) activeAbort = null;
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

// ─────────────────────────────────────────────────────────────────────────
// /compact path. Runs through the same queue as normal turns, so it
// serializes behind any in-flight reply rather than interrupting it.
// The CLI handles `/compact` as a local slash command (model loop is
// bypassed; the SDK emits a system/compact_boundary message with token
// stats once the summary is written back to the transcript).

interface CompactResult {
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
  error?: string;
}

async function runCompactJob(job: InboundJob & { targetSessionId: string }): Promise<void> {
  console.log(`inbound: compact sid=${shortSid(job.targetSessionId)}`);

  try {
    await bot.api.sendMessage(job.chatId, "🔄 Compacting connected session…", {
      reply_parameters: { message_id: job.userMessageId },
    });
  } catch (e) {
    console.error(`inbound: failed to send compact-start notice: ${(e as Error).message}`);
  }

  await sendTyping(job.chatId);
  const typingInterval = setInterval(() => void sendTyping(job.chatId), 4000);

  let result: CompactResult;
  try {
    result = await runClaudeCompact(job);
  } finally {
    clearInterval(typingInterval);
  }

  if (result.error) {
    if (result.error === "cancelled") return; // /cancel handler already informed the user
    const errShort = result.error.length > 600 ? result.error.slice(0, 600) + "…" : result.error;
    try {
      await bot.api.sendMessage(job.chatId, `⚠️ Compaction failed: ${errShort}`);
    } catch (e) {
      console.error(`inbound: failed to report compact error: ${(e as Error).message}`);
    }
    return;
  }

  let body = "✅ Compaction complete";
  if (result.preTokens != null && result.postTokens != null) {
    const pieces = [
      `${formatTokens(result.preTokens)} → ${formatTokens(result.postTokens)} tokens`,
    ];
    if (result.durationMs != null) {
      pieces.push(`${(result.durationMs / 1000).toFixed(1)}s`);
    }
    body += ` (${pieces.join(", ")})`;
  }

  try {
    await bot.api.sendMessage(job.chatId, body);
  } catch (e) {
    console.error(`inbound: failed to send compact-done notice: ${(e as Error).message}`);
  }
}

async function runClaudeCompact(job: InboundJob & { targetSessionId: string }): Promise<CompactResult> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    config.claudeTimeoutSec * 1000,
  );
  activeAbort = controller;

  const result: CompactResult = {};
  let sdkStderr = "";

  try {
    const q = query({
      prompt: COMPACT_SENTINEL,
      options: {
        resume: job.targetSessionId,
        cwd: job.targetCwd,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        abortController: controller,
        includePartialMessages: false,
        pathToClaudeCodeExecutable: claudeBinaryPath,
        // Skip the Telegram-shape nudge and telegram_send tool — /compact is
        // a local slash command that bypasses the model loop, so neither
        // would do anything useful here.
        stderr: (line: string) => { sdkStderr += line; },
      },
    });

    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "compact_boundary") {
        const meta = msg.compact_metadata;
        result.preTokens = meta.pre_tokens;
        result.postTokens = meta.post_tokens;
        result.durationMs = meta.duration_ms;
      } else if (msg.type === "result") {
        const r = msg as { subtype?: string; is_error?: boolean; errors?: string[] };
        if (r.subtype && r.subtype !== "success") {
          const detail = r.is_error ? (r.errors ?? []).join("; ") : "";
          result.error = `result subtype=${r.subtype}${detail ? ` — ${detail}` : ""}`;
        }
      }
    }
  } catch (e) {
    if (controller.signal.aborted) {
      result.error = controller.signal.reason === "user-cancel"
        ? "cancelled"
        : `timeout after ${config.claudeTimeoutSec}s`;
    } else {
      result.error = (e as Error).message ?? String(e);
    }
  } finally {
    clearTimeout(timer);
    if (activeAbort === controller) activeAbort = null;
  }

  if (result.error) {
    console.error(
      `inbound: compact failed sid=${shortSid(job.targetSessionId)} error=${result.error}` +
      (sdkStderr ? ` sdk_stderr=${sdkStderr.replace(/\s+/g, " ").slice(0, 1000)}` : ""),
    );
  } else {
    console.log(
      `inbound: compact ok sid=${shortSid(job.targetSessionId)} ` +
      `pre=${result.preTokens} post=${result.postTokens} dur_ms=${result.durationMs}`,
    );
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// /new path. Spawns a fresh Claude Code session in `targetCwd` (no resume),
// captures the SDK-assigned session id from the first stream message, and
// connects to it so the Stop hook's reply lands in Telegram normally.

async function runNewSessionJob(job: InboundJob): Promise<void> {
  console.log(`inbound: new-session cwd=${job.targetCwd} bytes=${job.text.length}`);

  await sendTyping(job.chatId);
  const typingInterval = setInterval(() => void sendTyping(job.chatId), 4000);

  let result: ClaudeResult;
  try {
    result = await runClaudeNew(job);
  } finally {
    clearInterval(typingInterval);
  }

  if (result.code !== 0 && result.stderr !== "cancelled") {
    const errShort = result.stderr.length > 600
      ? result.stderr.slice(0, 600) + "…"
      : result.stderr;
    const message = `⚠️ couldn't start session\n${errShort || "(no stderr)"}`;
    try {
      await bot.api.sendMessage(job.chatId, message, {
        reply_parameters: { message_id: job.userMessageId },
      });
    } catch (e) {
      console.error(`inbound: failed to report new-session error: ${(e as Error).message}`);
    }
  }
}

async function runClaudeNew(job: InboundJob): Promise<ClaudeResult> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    config.claudeTimeoutSec * 1000,
  );
  activeAbort = controller;

  let exitCode = 0;
  let stderr = "";
  let sdkStderr = "";
  let capturedSid: string | null = null;

  try {
    const q = query({
      prompt: job.text,
      options: {
        // No `resume` — the SDK assigns a fresh session id.
        cwd: job.targetCwd,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        abortController: controller,
        includePartialMessages: false,
        pathToClaudeCodeExecutable: claudeBinaryPath,
        systemPrompt: { type: "preset", preset: "claude_code", append: TELEGRAM_NUDGE },
        mcpServers: { telegram: getTelegramMcpServer() },
        stderr: (line: string) => { sdkStderr += line; },
      },
    });

    for await (const msg of q) {
      // Connect as soon as the SDK assigns the new session id, so the Stop
      // hook's POST (which fires after the result message) finds the active
      // pointer set and forwards to Telegram.
      if (!capturedSid && (msg as { session_id?: string }).session_id) {
        capturedSid = (msg as { session_id: string }).session_id;
        await setActiveSession(capturedSid, job.targetCwd);
        try {
          await bot.api.sendMessage(
            job.chatId,
            `🆕 Started session ${shortSid(capturedSid)} in ${job.targetCwd}`,
          );
        } catch (e) {
          console.error(`inbound: failed to send new-session notice: ${(e as Error).message}`);
        }
      }
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
    if (controller.signal.aborted) {
      stderr = controller.signal.reason === "user-cancel"
        ? "cancelled"
        : `timeout after ${config.claudeTimeoutSec}s`;
    } else {
      stderr = (e as Error).stack ?? String(e);
    }
  } finally {
    clearTimeout(timer);
    if (activeAbort === controller) activeAbort = null;
  }

  if (exitCode !== 0) {
    console.error(
      `inbound: new-session failed cwd=${job.targetCwd} code=${exitCode} stderr=${stderr}` +
      (sdkStderr ? ` sdk_stderr=${sdkStderr.replace(/\s+/g, " ").slice(0, 1000)}` : ""),
    );
  } else {
    console.log(
      `inbound: new-session ok sid=${capturedSid ? shortSid(capturedSid) : "?"} cwd=${job.targetCwd}`,
    );
  }

  return { code: exitCode, stderr };
}
