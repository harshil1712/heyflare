export const ink = "#111111";
export const muted = "#5c5c5c";
export const border = "#e5e5e5";
export const bg = "#f7f7f7";
export const danger = "#111111";
export const surface = "#ffffff";

export function formatWhen(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function fromLabel(name: string, email: string): string {
  return name?.trim() || email || "Unknown";
}

export const BUCKET_LABELS: Record<string, string> = {
  paper_trail: "Paper Trail",
  reply_later: "Reply Later",
  set_aside: "Set Aside",
  bubble_up: "Bubble Up",
  previously_seen: "Previously seen",
  sent: "Sent",
  trash: "Trash",
  everything: "Everything",
  screened_out: "Screened out",
  drafts: "Drafts",
  scheduled: "Scheduled",
};
