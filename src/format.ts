// Display helpers. Pure functions, no side effects.

export function shortSid(sid: string): string {
  const dash = sid.indexOf("-");
  return dash >= 0 ? sid.slice(0, dash) : sid.slice(0, 8);
}

export function age(epochMs: number): string {
  const delta = (Date.now() - epochMs) / 1000;
  if (delta < 60) return `${Math.floor(delta)}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

export function truncate(s: string, n: number): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  if (collapsed.length <= n) return collapsed;
  return collapsed.slice(0, n - 1).trimEnd() + "…";
}
