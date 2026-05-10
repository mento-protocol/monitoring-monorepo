"use client";

import { useRef, useState } from "react";
import type React from "react";

type ArrowKeyMode = "horizontal" | "all";
type ActivationMode = "manual" | "automatic";
type RovingItemRefCallback = (node: HTMLButtonElement | null) => void;

export interface UseRovingTabIndexOptions {
  activeIndex: number;
  itemCount: number;
  arrowKeys?: ArrowKeyMode;
  activation?: ActivationMode;
  onActivate?: (index: number) => void;
}

export interface RovingItemProps {
  ref: RovingItemRefCallback;
  tabIndex: number;
  onFocus: () => void;
}

function clampIndex(index: number, itemCount: number): number {
  if (itemCount <= 0) return -1;
  return Math.min(Math.max(index, 0), itemCount - 1);
}

/**
 * WAI-ARIA roving-tabindex helper for controlled button groups.
 *
 * The single `tabIndex={0}` follows local focus, not the controlled active
 * prop. This matters for URL-backed widgets where the active prop can lag
 * behind arrow-key focus while `router.replace` or another side effect settles.
 *
 * Current callers attach `groupRef` to a `<div>` wrapper. If we add non-div
 * button groups, make the group element type generic before widening usage.
 */
export function useRovingTabIndex({
  activeIndex,
  itemCount,
  arrowKeys = "all",
  activation = "automatic",
  onActivate,
}: UseRovingTabIndexOptions) {
  const groupRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const itemRefCallbacksRef = useRef(new Map<number, RovingItemRefCallback>());
  itemsRef.current.length = itemCount;

  const normalizedActiveIndex = clampIndex(activeIndex, itemCount);
  const [focusedIndex, setFocusedIndex] = useState(normalizedActiveIndex);

  // Re-sync to the controlled active prop when focus is outside the group.
  // Do this during render rather than in an effect to avoid the extra stale
  // frame and the no-direct-set-state-in-use-effect lint.
  const lastSyncRef = useRef({ activeIndex: normalizedActiveIndex, itemCount });
  if (
    lastSyncRef.current.activeIndex !== normalizedActiveIndex ||
    lastSyncRef.current.itemCount !== itemCount
  ) {
    lastSyncRef.current = { activeIndex: normalizedActiveIndex, itemCount };
    const activeElement =
      typeof document === "undefined" ? null : document.activeElement;
    if (!groupRef.current?.contains(activeElement)) {
      setFocusedIndex(normalizedActiveIndex);
    } else if (focusedIndex >= itemCount) {
      setFocusedIndex(clampIndex(focusedIndex, itemCount));
    }
  }

  function getItemRef(index: number): RovingItemRefCallback {
    const existingRef = itemRefCallbacksRef.current.get(index);
    if (existingRef) return existingRef;

    const itemRef: RovingItemRefCallback = (node) => {
      itemsRef.current[index] = node;
    };
    itemRefCallbacksRef.current.set(index, itemRef);
    return itemRef;
  }

  function getItemProps(index: number): RovingItemProps {
    return {
      ref: getItemRef(index),
      tabIndex: index === focusedIndex ? 0 : -1,
      onFocus: () => setFocusedIndex(index),
    };
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const key = e.key;
    const isHorizontal =
      key === "ArrowLeft" ||
      key === "ArrowRight" ||
      key === "Home" ||
      key === "End";
    const isVertical =
      arrowKeys === "all" && (key === "ArrowUp" || key === "ArrowDown");
    if (!isHorizontal && !isVertical) return;

    e.preventDefault();
    if (itemCount <= 0) return;

    const currentIndex = itemsRef.current.indexOf(
      e.target as HTMLButtonElement,
    );
    const fromIndex =
      currentIndex === -1 ? clampIndex(focusedIndex, itemCount) : currentIndex;

    let nextIndex: number;
    if (key === "Home") {
      nextIndex = 0;
    } else if (key === "End") {
      nextIndex = itemCount - 1;
    } else if (key === "ArrowRight" || key === "ArrowDown") {
      nextIndex = (fromIndex + 1) % itemCount;
    } else {
      nextIndex = (fromIndex - 1 + itemCount) % itemCount;
    }

    itemsRef.current[nextIndex]?.focus();
    if (activation === "automatic") {
      onActivate?.(nextIndex);
    }
  }

  return {
    groupRef,
    focusedIndex,
    getItemProps,
    handleKeyDown,
  };
}
