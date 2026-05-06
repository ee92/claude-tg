// SDK MCP tool that lets the agent send a file from local disk to the
// Telegram chat the user is messaging from.
//
// Registered in-process: the tool function runs in this Node process (same
// place as the grammY bot), so we can call `bot.api.sendPhoto` / `sendDocument`
// directly with a `new InputFile(path)`. The agent invokes it during the turn;
// the file lands in Telegram immediately, before the assistant's text reply.
//
// Why one tool that auto-detects: keeping the agent's tool surface small.
// `telegram_send` with a path is enough — we pick photo vs document by
// extension and Telegram's matching size limits.
//
// We require absolute paths because the tool runs in the bridge's process,
// not the agent's working directory — a relative path would resolve against
// the wrong cwd. The tool description tells the model so up front.

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { Bot, InputFile } from "grammy";
import { promises as fs } from "node:fs";
import path from "node:path";

const PHOTO_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;     // Telegram cloud Bot API limit
const DOCUMENT_MAX_BYTES = 50 * 1024 * 1024;  // Telegram cloud Bot API limit

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

// Factory takes the bot + target chat as parameters rather than importing
// them, so this module doesn't form an import cycle with telegram.ts (which
// itself imports inbound.ts).
export function createTelegramAttachServer(bot: Bot, chatId: number) {
  const sendAttachment = tool(
    "telegram_send",
    "Send an image, photo, or document file from local disk to the Telegram " +
      "chat the user is messaging from. Use this when the user asks you to " +
      "show them an image, when you generate a chart/screenshot/diagram, or " +
      "when sharing a file is more useful than describing it in text. " +
      "Auto-detects photo vs document from the file extension. Path must be " +
      "absolute.",
    {
      path: z.string().describe("Absolute path to the file on local disk."),
      caption: z
        .string()
        .optional()
        .describe("Optional caption shown alongside the file in Telegram."),
    },
    async ({ path: filePath, caption }) => {
      if (!path.isAbsolute(filePath)) {
        return err(
          `Path must be absolute. Got "${filePath}" — re-call with the full path.`,
        );
      }

      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch {
        return err(`File not found at ${filePath}`);
      }
      if (!stat.isFile()) {
        return err(`Path is not a regular file: ${filePath}`);
      }

      const ext = path.extname(filePath).toLowerCase();
      const isPhoto = PHOTO_EXTS.has(ext);
      const limit = isPhoto ? PHOTO_MAX_BYTES : DOCUMENT_MAX_BYTES;
      if (stat.size > limit) {
        const mb = (stat.size / (1024 * 1024)).toFixed(1);
        const limitMb = (limit / (1024 * 1024)).toFixed(0);
        return err(
          `File is ${mb} MB, exceeds Telegram's ${limitMb} MB limit for ` +
            `${isPhoto ? "photos" : "documents"}.`,
        );
      }

      const kind = isPhoto ? "photo" : "document";
      console.log(
        `telegram_send: ${kind} ${filePath} (${(stat.size / 1024).toFixed(1)} KB)`,
      );
      try {
        const file = new InputFile(filePath);
        if (isPhoto) {
          await bot.api.sendPhoto(chatId, file, { caption });
        } else {
          await bot.api.sendDocument(chatId, file, { caption });
        }
        return ok(
          `Sent ${kind} ${path.basename(filePath)} to Telegram ` +
            `(${(stat.size / 1024).toFixed(1)} KB).`,
        );
      } catch (e) {
        const msg = (e as Error).message;
        console.error(`telegram_send failed for ${filePath}: ${msg}`);
        return err(`Telegram API rejected the upload: ${msg}`);
      }
    },
  );

  return createSdkMcpServer({
    name: "telegram",
    version: "1.0.0",
    tools: [sendAttachment],
    alwaysLoad: true,
  });
}
