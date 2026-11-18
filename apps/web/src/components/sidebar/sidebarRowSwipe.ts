import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useState,
} from "react";

export const SIDEBAR_SWIPE_ACTION_WIDTH = 72;
const LOCK_DISTANCE = 8;
const SNAP_TRANSITION = "180ms cubic-bezier(0.2, 0.8, 0.2, 1)";

/** Same thresholds as the mobile app's thread swipe: a long pull commits the action. */
function resolveSidebarSwipeRelease(input: {
  readonly offset: number;
  readonly rowWidth: number;
}): "commit" | "open" | "close" {
  const distance = -input.offset;
  if (distance >= Math.max(SIDEBAR_SWIPE_ACTION_WIDTH + 44, input.rowWidth * 0.58)) {
    return "commit";
  }
  return distance >= SIDEBAR_SWIPE_ACTION_WIDTH / 2 ? "open" : "close";
}

interface SwipeGesture {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly base: number;
  readonly rowWidth: number;
  locked: boolean | null;
  offset: number;
}

// One revealed row at a time, as in the mobile thread list.
let closeRevealedRow: (() => void) | null = null;

function createSidebarRowSwipe() {
  let content: HTMLElement | null = null;
  let action: HTMLButtonElement | null = null;
  let gesture: SwipeGesture | null = null;
  let open = false;
  let suppressClick = false;
  let enabled = false;
  let onCommit = () => {};

  const apply = (offset: number, animate: boolean) => {
    const transition = animate ? SNAP_TRANSITION : "0s";
    if (content) {
      content.style.transition = `transform ${transition}`;
      content.style.transform = offset === 0 ? "" : `translateX(${offset}px)`;
    }
    if (!action) return;
    const button = action;
    button.style.transition = `width ${transition}`;
    button.style.width = `${Math.max(SIDEBAR_SWIPE_ACTION_WIDTH, -offset)}px`;
    if (offset !== 0) {
      button.style.visibility = "visible";
    } else if (!animate || !content) {
      button.style.visibility = "hidden";
    } else {
      content.addEventListener(
        "transitionend",
        () => {
          if (!open && gesture === null) button.style.visibility = "hidden";
        },
        { once: true },
      );
    }
  };
  const onOutsidePointerDown = (event: PointerEvent) => {
    const target = event.target as Node | null;
    if (target && (content?.contains(target) || action?.contains(target))) return;
    close();
  };
  const setOpen = (next: boolean) => {
    if (open === next) return;
    open = next;
    if (next) {
      if (closeRevealedRow !== close) closeRevealedRow?.();
      closeRevealedRow = close;
      document.addEventListener("pointerdown", onOutsidePointerDown, { capture: true });
    } else {
      if (closeRevealedRow === close) closeRevealedRow = null;
      document.removeEventListener("pointerdown", onOutsidePointerDown, { capture: true });
    }
  };
  function close() {
    setOpen(false);
    apply(0, true);
  }
  const commit = () => {
    setOpen(false);
    apply(0, false);
    onCommit();
  };
  const restingOffset = () => (open ? -SIDEBAR_SWIPE_ACTION_WIDTH : 0);

  return {
    configure(options: { readonly enabled: boolean; readonly onCommit: () => void }) {
      enabled = options.enabled;
      onCommit = options.onCommit;
    },
    // Callback refs detach and reattach on every render, so null must not reset `open`.
    bindRow(element: HTMLElement | null) {
      if (element !== null) content = element;
    },
    bindAction(element: HTMLButtonElement | null) {
      if (element !== null) action = element;
    },
    rowHandlers: {
      onPointerDown(event: ReactPointerEvent<HTMLElement>) {
        suppressClick = false;
        if (event.pointerType !== "touch" || !event.isPrimary || !enabled) return;
        gesture = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          base: restingOffset(),
          rowWidth: content?.getBoundingClientRect().width ?? 0,
          locked: null,
          offset: restingOffset(),
        };
      },
      onPointerMove(event: ReactPointerEvent<HTMLElement>) {
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        const dx = event.clientX - gesture.startX;
        const dy = event.clientY - gesture.startY;
        if (gesture.locked === null) {
          if (Math.hypot(dx, dy) < LOCK_DISTANCE) return;
          gesture.locked = Math.abs(dx) > Math.abs(dy);
          if (!gesture.locked) {
            gesture = null;
            return;
          }
          if (closeRevealedRow !== close) closeRevealedRow?.();
        }
        gesture.offset = Math.min(0, Math.max(-gesture.rowWidth, gesture.base + dx));
        apply(gesture.offset, false);
      },
      onPointerUp(event: ReactPointerEvent<HTMLElement>) {
        const released = gesture;
        if (!released || released.pointerId !== event.pointerId) return;
        gesture = null;
        if (!released.locked) {
          // A tap on a revealed row closes it instead of opening the thread.
          if (open) {
            suppressClick = true;
            close();
          }
          return;
        }
        suppressClick = true;
        const release = resolveSidebarSwipeRelease(released);
        if (release === "commit") {
          commit();
        } else if (release === "open") {
          setOpen(true);
          apply(-SIDEBAR_SWIPE_ACTION_WIDTH, true);
        } else {
          close();
        }
      },
      onPointerCancel(event: ReactPointerEvent<HTMLElement>) {
        const cancelled = gesture;
        if (!cancelled || cancelled.pointerId !== event.pointerId) return;
        gesture = null;
        if (cancelled.locked) apply(restingOffset(), true);
      },
      onClickCapture(event: ReactMouseEvent<HTMLElement>) {
        if (!suppressClick) return;
        suppressClick = false;
        event.preventDefault();
        event.stopPropagation();
      },
    },
    onActionClick(event: ReactMouseEvent<HTMLButtonElement>) {
      event.preventDefault();
      event.stopPropagation();
      commit();
    },
  };
}

/**
 * Touch-only swipe-left on a sidebar row. Offsets are written straight to the
 * row's style so a drag never re-renders the memoized row.
 */
export function useSidebarRowSwipe(options: {
  readonly enabled: boolean;
  readonly onCommit: () => void;
}) {
  const [swipe] = useState(createSidebarRowSwipe);
  swipe.configure(options);
  return swipe;
}
