// Tiny interactive-prompt helpers, no deps.
//
// Two modes, picked by stdin's TTY-ness:
//   - TTY (real terminal): readline.question, one prompt at a time.
//   - Pipe (scripted/CI): pre-read all of stdin, split into lines, dispense
//     them as answers in order. Node's readline.question is unreliable for
//     more than one sequential prompt when stdin is a pipe.

import readline from "node:readline";
import type { Interface } from "node:readline";

let rl: Interface | null = null;
let pipedLines: string[] | null = null;
let pipedReadPromise: Promise<void> | null = null;

function isTty(): boolean {
  return Boolean(process.stdin.isTTY);
}

function ensurePipedRead(): Promise<void> {
  if (pipedReadPromise) return pipedReadPromise;
  pipedReadPromise = new Promise<void>((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buf += chunk;
    });
    process.stdin.on("end", () => {
      pipedLines = buf.split("\n");
      // A trailing newline produces an empty final element — drop it so
      // we don't dispense a phantom empty answer at the end.
      if (pipedLines.length > 0 && pipedLines[pipedLines.length - 1] === "") {
        pipedLines.pop();
      }
      resolve();
    });
  });
  return pipedReadPromise;
}

function getRl(): Interface {
  if (rl) return rl;
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return rl;
}

export function closePrompts(): void {
  if (rl) {
    rl.close();
    rl = null;
  }
}

async function readOne(prompt: string): Promise<string> {
  if (isTty()) {
    const r = getRl();
    return new Promise<string>((resolve) => {
      r.question(prompt, (a) => resolve(a));
    });
  }
  await ensurePipedRead();
  const lines = pipedLines ?? [];
  const next = lines.length > 0 ? lines.shift()! : "";
  // Echo the prompt + the answer so logs of scripted runs are readable.
  process.stdout.write(`${prompt}${next}\n`);
  return next;
}

export async function ask(question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue !== undefined ? ` [${defaultValue}]` : "";
  const answer = await readOne(`${question}${suffix} `);
  const trimmed = answer.trim();
  if (!trimmed && defaultValue !== undefined) return defaultValue;
  return trimmed;
}

export async function askRequired(question: string): Promise<string> {
  for (;;) {
    const a = await ask(question);
    if (a) return a;
    console.log("(value required)");
    if (!isTty()) {
      // No more lines coming on a pipe — bail out rather than spin forever.
      throw new Error(`Required value missing for prompt: ${question}`);
    }
  }
}

export async function askInt(question: string, defaultValue?: number): Promise<number> {
  for (;;) {
    const a = await ask(question, defaultValue !== undefined ? String(defaultValue) : undefined);
    if (!a && defaultValue !== undefined) return defaultValue;
    const n = Number(a);
    if (Number.isInteger(n)) return n;
    console.log("(must be an integer)");
    if (!isTty()) {
      throw new Error(`Required integer missing for prompt: ${question}`);
    }
  }
}

export async function askYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  const a = (await ask(`${question} (${hint})`)).toLowerCase();
  if (!a) return defaultYes;
  return a === "y" || a === "yes";
}
