// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePolling } from "../src/hooks/usePolling.js";
import { advance, installCommonHooks, useFakeClock } from "./support.js";

installCommonHooks();

function Poller(props: {
  enabled: boolean;
  intervalMs?: number;
  tick: (signal: AbortSignal) => Promise<void>;
}) {
  usePolling({ enabled: props.enabled, intervalMs: props.intervalMs ?? 1000, tick: props.tick });
  return null;
}

describe("usePolling", () => {
  it("calls the tick one interval after it is enabled, and then once per interval", async () => {
    useFakeClock();
    const tick = vi.fn(async () => undefined);
    render(<Poller enabled tick={tick} />);
    expect(tick).not.toHaveBeenCalled();
    await advance(999);
    expect(tick).not.toHaveBeenCalled();
    await advance(1);
    expect(tick).toHaveBeenCalledTimes(1);
    await advance(3000);
    expect(tick).toHaveBeenCalledTimes(4);
  });

  it("does nothing while it is disabled", async () => {
    useFakeClock();
    const tick = vi.fn(async () => undefined);
    render(<Poller enabled={false} tick={tick} />);
    await advance(10_000);
    expect(tick).not.toHaveBeenCalled();
  });

  it("starts when it becomes enabled and stops when it becomes disabled", async () => {
    useFakeClock();
    const tick = vi.fn(async () => undefined);
    const { rerender } = render(<Poller enabled={false} tick={tick} />);
    rerender(<Poller enabled tick={tick} />);
    await advance(2000);
    expect(tick).toHaveBeenCalledTimes(2);
    rerender(<Poller enabled={false} tick={tick} />);
    await advance(5000);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("waits for a slow tick to finish before it waits the next interval, so two never overlap", async () => {
    useFakeClock();
    let running = 0;
    let most = 0;
    let finish: () => void = () => undefined;
    const tick = vi.fn(async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      running -= 1;
    });
    render(<Poller enabled tick={tick} />);
    await advance(1000);
    expect(tick).toHaveBeenCalledTimes(1);
    await advance(10_000);
    expect(tick).toHaveBeenCalledTimes(1);
    finish();
    await advance(999);
    expect(tick).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(most).toBe(1);
  });

  it("clears the timer when the component goes away", async () => {
    useFakeClock();
    const tick = vi.fn(async () => undefined);
    const { unmount } = render(<Poller enabled tick={tick} />);
    await advance(1000);
    expect(tick).toHaveBeenCalledTimes(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await advance(10_000);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("aborts the call in progress when the component goes away, and does not start another", async () => {
    useFakeClock();
    let seen: AbortSignal | undefined;
    let finish: () => void = () => undefined;
    const tick = vi.fn(async (signal: AbortSignal) => {
      seen = signal;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const { unmount } = render(<Poller enabled tick={tick} />);
    await advance(1000);
    expect(seen?.aborted).toBe(false);
    unmount();
    expect(seen?.aborted).toBe(true);
    finish();
    await advance(10_000);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps going when a tick throws", async () => {
    useFakeClock();
    const tick = vi.fn(async () => {
      throw new Error("boom");
    });
    render(<Poller enabled tick={tick} />);
    await advance(3000);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it("uses the newest tick without restarting the timer", async () => {
    useFakeClock();
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    const { rerender } = render(<Poller enabled tick={first} />);
    await advance(600);
    rerender(<Poller enabled tick={second} />);
    // The timer was not restarted: 400 ms more is enough.
    await advance(400);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("restarts the wait when the interval changes", async () => {
    useFakeClock();
    const tick = vi.fn(async () => undefined);
    const { rerender } = render(<Poller enabled tick={tick} intervalMs={5000} />);
    await advance(4000);
    rerender(<Poller enabled tick={tick} intervalMs={1000} />);
    await advance(1000);
    expect(tick).toHaveBeenCalledTimes(1);
  });
});
