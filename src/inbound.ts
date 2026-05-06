// Inbound queue: Telegram free text → connected Claude session via the system
// `claude -p -r <sid>` CLI. The response itself is NOT forwarded from here —
// it arrives back through the Stop hook → /stop → Telegram path, so external
// turns and bridge-driven turns share a single fan-in.

import { spawn } from "node:child_process";
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
    `inbound: spawn sid=${shortSid(job.targetSessionId)} cwd=${job.targetCwd} bytes=${job.text.length}`
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

function runClaude(job: InboundJob): Promise<ClaudeResult> {
  return new Promise((resolve) => {
    const proc = spawn(config.claudeBin, ["-p", "-r", job.targetSessionId], {
      cwd: job.targetCwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    proc.stdout.on("data", (b) => { stdout += b.toString("utf8"); });
    proc.stderr.on("data", (b) => { stderr += b.toString("utf8"); });

    const killer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, config.claudeTimeoutSec * 1000);

    proc.on("close", (code) => {
      clearTimeout(killer);
      if (timedOut) {
        resolve({ code: -1, stdout, stderr: stderr || `timeout after ${config.claudeTimeoutSec}s` });
      } else {
        resolve({ code: code ?? -1, stdout, stderr });
      }
    });

    proc.on("error", (e) => {
      clearTimeout(killer);
      resolve({ code: -1, stdout, stderr: stderr + `\nspawn error: ${e.message}` });
    });

    proc.stdin.end(job.text, "utf8");
  });
}
