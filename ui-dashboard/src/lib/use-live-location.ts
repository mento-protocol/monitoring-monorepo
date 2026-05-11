"use client";

import { useSyncExternalStore } from "react";

const LOCATION_CHANGE_EVENT = "mento:locationchange";
const SNAPSHOT_SEPARATOR = "\0";

declare global {
  interface Window {
    __mentoLocationChangePatched?: boolean;
  }
}

function dispatchLocationChange() {
  window.dispatchEvent(new Event(LOCATION_CHANGE_EVENT));
}

function patchHistoryMethods() {
  if (typeof window === "undefined") return;
  if (window.__mentoLocationChangePatched) return;
  window.__mentoLocationChangePatched = true;

  const originalPushState = window.history.pushState;
  const originalReplaceState = window.history.replaceState;

  window.history.pushState = function pushState(
    ...args: Parameters<History["pushState"]>
  ) {
    originalPushState.apply(this, args);
    dispatchLocationChange();
  };

  window.history.replaceState = function replaceState(
    ...args: Parameters<History["replaceState"]>
  ) {
    originalReplaceState.apply(this, args);
    dispatchLocationChange();
  };
}

function subscribeToLocationChange(callback: () => void) {
  if (typeof window === "undefined") return () => {};

  patchHistoryMethods();
  window.addEventListener(LOCATION_CHANGE_EVENT, callback);
  window.addEventListener("popstate", callback);
  return () => {
    window.removeEventListener(LOCATION_CHANGE_EVENT, callback);
    window.removeEventListener("popstate", callback);
  };
}

function getLocationSnapshot() {
  if (typeof window === "undefined") return `/${SNAPSHOT_SEPARATOR}`;
  return `${window.location.pathname}${SNAPSHOT_SEPARATOR}${window.location.search}`;
}

function splitLocationSnapshot(snapshot: string) {
  const separatorIndex = snapshot.indexOf(SNAPSHOT_SEPARATOR);
  if (separatorIndex === -1) return { pathname: snapshot || "/", search: "" };
  return {
    pathname: snapshot.slice(0, separatorIndex) || "/",
    search: snapshot.slice(separatorIndex + SNAPSHOT_SEPARATOR.length),
  };
}

export function useLiveLocation() {
  const snapshot = useSyncExternalStore(
    subscribeToLocationChange,
    getLocationSnapshot,
    getLocationSnapshot,
  );
  return splitLocationSnapshot(snapshot);
}
