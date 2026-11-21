import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { useSidebarRowSwipe } from "./sidebarRowSwipe";

const ROW_WIDTH = 300;

function SwipeRow(props: { readonly onCommit: () => void; readonly onOpen: () => void }) {
  const { bindRow, bindAction, rowHandlers, onActionClick } = useSidebarRowSwipe({
    enabled: true,
    onCommit: props.onCommit,
  });
  return (
    <div style={{ position: "relative", width: ROW_WIDTH }}>
      <div
        ref={(row) => bindRow(row)}
        role="button"
        tabIndex={0}
        onClick={props.onOpen}
        {...rowHandlers}
      >
        Thread
      </div>
      <button ref={bindAction} type="button" onClick={onActionClick}>
        Settle
      </button>
    </div>
  );
}

function pointer(target: Element, type: string, x: number, pointerType = "touch") {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      isPrimary: true,
      pointerId: 7,
      pointerType,
      clientX: x,
      clientY: 10,
    }),
  );
}

async function swipe(target: Element, distance: number, pointerType = "touch") {
  await act(() => {
    pointer(target, "pointerdown", 280, pointerType);
    pointer(target, "pointermove", 270, pointerType);
    pointer(target, "pointermove", 280 - distance, pointerType);
    pointer(target, "pointerup", 280 - distance, pointerType);
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function tap(target: Element) {
  await act(() => {
    pointer(target, "pointerdown", 150);
    pointer(target, "pointerup", 150);
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function renderRow() {
  const onCommit = vi.fn();
  const onOpen = vi.fn();
  const screen = await render(<SwipeRow onCommit={onCommit} onOpen={onOpen} />, {
    // No router: the row is a bare gesture harness.
    router: false,
  });
  const row = screen.getByText("Thread").element();
  return { screen, row, onCommit, onOpen };
}

describe("useSidebarRowSwipe", () => {
  it("commits the action on a long swipe without opening the thread", async () => {
    const { screen, row, onCommit, onOpen } = await renderRow();
    await using _screen = screen;

    await swipe(row, 220);

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("reveals the action on a short swipe, and a tap closes it instead of opening", async () => {
    const { screen, row, onCommit, onOpen } = await renderRow();
    await using _screen = screen;

    await swipe(row, 80);
    expect(onCommit).not.toHaveBeenCalled();
    expect((row as HTMLElement).style.transform).toBe("translateX(-72px)");

    await tap(row);
    expect(onOpen).not.toHaveBeenCalled();
    expect((row as HTMLElement).style.transform).toBe("");

    await tap(row);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("stays revealed across a re-render of the row", async () => {
    const { screen, row, onOpen } = await renderRow();
    await using _screen = screen;

    await swipe(row, 80);
    await screen.rerender(<SwipeRow onCommit={vi.fn()} onOpen={onOpen} />);
    expect((row as HTMLElement).style.transform).toBe("translateX(-72px)");

    await tap(row);
    expect(onOpen).not.toHaveBeenCalled();
    expect((row as HTMLElement).style.transform).toBe("");
  });

  it("commits from the revealed action button", async () => {
    const { screen, row, onCommit } = await renderRow();
    await using _screen = screen;

    await swipe(row, 80);
    await act(() => (screen.getByText("Settle").element() as HTMLElement).click());

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect((row as HTMLElement).style.transform).toBe("");
  });

  it("leaves mouse drags to the sidebar's drag and sweep handling", async () => {
    const { screen, row, onCommit, onOpen } = await renderRow();
    await using _screen = screen;

    await swipe(row, 220, "mouse");

    expect(onCommit).not.toHaveBeenCalled();
    expect((row as HTMLElement).style.transform).toBe("");
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
