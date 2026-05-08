// /model picker support: live-fetch the connected session's available
// models from the SDK. Mirrors the commandList.ts pattern — the only way
// to call Query.supportedModels() is in streaming-input mode, so we feed
// query() an idle generator that resolves on abort, pull the list, abort.
//
// Module-level cache is per-cwd, invalidated on session switch (same as the
// command list cache, cleared via clearModelCache()).

import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { claudeBinaryPath } from "./sdkBinary.js";

export interface ModelEntry {
  // Canonical id passed to query() options.model. Accepts both aliases
  // (e.g. "sonnet") and full ids (e.g. "claude-opus-4-7").
  value: string;
  // Human-readable display name for the keyboard label.
  displayName: string;
  // Short capability description from the SDK (e.g. "Hybrid model that...").
  description: string;
}

let cachedByCwd: { cwd: string; models: ModelEntry[] } | null = null;

export function clearModelCache(): void {
  cachedByCwd = null;
}

// Idle prompt source — see commandList.ts for the rationale.
async function* idleInput(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return; }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export async function fetchModelList(cwd: string): Promise<ModelEntry[]> {
  // Per-cwd cache hit: model availability shouldn't change within a session.
  if (cachedByCwd && cachedByCwd.cwd === cwd) return cachedByCwd.models;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("models-timeout"), 30_000);
  try {
    const q = query({
      prompt: idleInput(controller.signal),
      options: {
        cwd,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        abortController: controller,
        includePartialMessages: false,
        pathToClaudeCodeExecutable: claudeBinaryPath,
      },
    });

    const raw = await q.supportedModels();
    controller.abort("models-got-list");
    try { for await (const _ of q) { /* discard */ } } catch { /* aborted */ }

    const models: ModelEntry[] = raw.map((m) => ({
      value: m.value,
      displayName: m.displayName || m.value,
      description: m.description || "",
    }));

    cachedByCwd = { cwd, models };
    return models;
  } finally {
    clearTimeout(timer);
  }
}
