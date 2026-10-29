import { useEffect, useState } from "react";

/**
 * Which column owns the arrow keys: sidebar │ content.
 * Kept in a module store so the Shell and every ThreadList agree without prop drilling.
 */
export type FocusRegion = "content" | "sidebar";

let region: FocusRegion = "content";
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export const focus = {
  get: () => region,
  set(next: FocusRegion) {
    if (region === next) return;
    region = next;
    emit();
  },
  toContent: () => focus.set("content"),
  toSidebar: () => focus.set("sidebar"),
};

export function useFocusRegion(): FocusRegion {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((x) => x + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return region;
}

/**
 * A page can take the arrow keys for itself, which would otherwise step out to the sidebar. The sidebar keeps them once focus is actually in it, so
 * Escape is still the way back.
 */
let claimed = 0;
export const arrows = {
  claim() {
    claimed++;
    return () => {
      claimed = Math.max(0, claimed - 1);
    };
  },
  claimed: () => claimed > 0,
};

/** True while a menu, dialog, popover or listbox is open — arrow keys belong to it, not to us. */
export function overlayOpen(): boolean {
  const nodes = document.querySelectorAll('[role="menu"],[role="dialog"],[role="alertdialog"],[role="listbox"],[data-slot="popover-content"]');
  return nodes.length > 0;
}
