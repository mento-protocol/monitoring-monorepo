"use client";

import { useEffect, useReducer, type RefObject } from "react";

export type DeferredMountMode = "none" | "idle" | "visible";

const IDLE_TIMEOUT_MS = 1_500;
const VISIBLE_ROOT_MARGIN = "200px 0px";

function requestIdle(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const requestIdleCallback = window.requestIdleCallback;
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(callback, {
      timeout: IDLE_TIMEOUT_MS,
    });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = globalThis.setTimeout(callback, 1);
  return () => globalThis.clearTimeout(handle);
}

export function useDeferredMount(
  mode: DeferredMountMode,
  targetRef: RefObject<Element | null>,
  enabled: boolean,
): boolean {
  const [shouldMount, dispatchMount] = useReducer(
    (_current: boolean, next: boolean) => next,
    enabled && mode === "none",
  );

  useEffect(() => {
    if (!enabled) {
      dispatchMount(false);
      return;
    }
    if (mode === "none") {
      dispatchMount(true);
      return;
    }

    dispatchMount(false);
    if (mode === "idle") {
      return requestIdle(() => dispatchMount(true));
    }

    const target = targetRef.current;
    if (!target || typeof IntersectionObserver === "undefined") {
      dispatchMount(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          dispatchMount(true);
          observer.disconnect();
        }
      },
      { rootMargin: VISIBLE_ROOT_MARGIN },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [enabled, mode, targetRef]);

  return shouldMount;
}
