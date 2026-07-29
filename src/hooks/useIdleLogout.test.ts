import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { IDLE_LOGOUT_MS, useIdleLogout } from "./useIdleLogout";

describe("useIdleLogout (#76)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("signs out after the idle window", () => {
    const onIdle = vi.fn();
    renderHook(() => useIdleLogout(true, onIdle, 1000));
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1001);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("real input restarts the clock", () => {
    const onIdle = vi.fn();
    renderHook(() => useIdleLogout(true, onIdle, 1000));
    vi.advanceTimersByTime(900);
    window.dispatchEvent(new Event("keydown"));
    vi.advanceTimersByTime(900);
    expect(onIdle).not.toHaveBeenCalled(); // 1800ms elapsed, but only 900 idle
    vi.advanceTimersByTime(200);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("a drifting mouse is not presence", () => {
    const onIdle = vi.fn();
    renderHook(() => useIdleLogout(true, onIdle, 1000));
    vi.advanceTimersByTime(900);
    window.dispatchEvent(new Event("mousemove"));
    vi.advanceTimersByTime(200);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("does nothing when disabled (nobody signed in, or a viewer)", () => {
    const onIdle = vi.fn();
    renderHook(() => useIdleLogout(false, onIdle, 1000));
    vi.advanceTimersByTime(5000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("stops on unmount", () => {
    const onIdle = vi.fn();
    const { unmount } = renderHook(() => useIdleLogout(true, onIdle, 1000));
    unmount();
    vi.advanceTimersByTime(5000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("defaults to a 30 minute window", () => {
    expect(IDLE_LOGOUT_MS).toBe(30 * 60_000);
  });
});
