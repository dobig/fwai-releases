import { observeResize } from "~/lib/observeResize";

/**
 * The titlebar controls float over the header rows (fixed or absolute), so a row cannot see
 * them in its own layout. Rows measure where the controls actually sit and pad themselves
 * clear, whichever controls are showing and however wide they are.
 */
const CONTROLS_SELECTOR = "[data-workspace-titlebar-controls]";
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

/** Ref for a controls overlay: rows re-measure when it appears, resizes or goes. */
export function trackTitlebarControls(element: HTMLElement | null) {
  if (element === null) return;
  notify();
  const stop = observeResize(element, notify);
  return () => {
    stop();
    // After React detaches it, so the measurement no longer sees it.
    queueMicrotask(notify);
  };
}

/** How far the row's right edge reaches under controls that share its line. */
export function titlebarOverlap(
  row: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
  controls: ReadonlyArray<Pick<DOMRect, "left" | "right" | "top" | "bottom" | "width">>,
): number {
  let overlap = 0;
  for (const rect of controls) {
    if (rect.width === 0 || rect.bottom <= row.top || rect.top >= row.bottom) continue;
    if (rect.left >= row.right || rect.right <= row.left) continue;
    overlap = Math.max(overlap, row.right - rect.left);
  }
  return overlap;
}

/** Ref for a header row: keeps its end clear of the controls, `gap` px beyond their edge. */
export function clearTitlebarControls(gap = 8) {
  return (row: HTMLElement | null) => {
    if (row === null) return;
    const measure = () => {
      const controls = [...document.querySelectorAll<HTMLElement>(CONTROLS_SELECTOR)].map(
        (element) => element.getBoundingClientRect(),
      );
      const overlap = titlebarOverlap(row.getBoundingClientRect(), controls);
      if (overlap > 0) row.style.paddingRight = `${Math.ceil(overlap + gap)}px`;
      else row.style.removeProperty("padding-right");
    };
    measure();
    listeners.add(measure);
    const stop = observeResize(row, measure);
    window.addEventListener("resize", measure);
    return () => {
      listeners.delete(measure);
      stop();
      window.removeEventListener("resize", measure);
    };
  };
}
