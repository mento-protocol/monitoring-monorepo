import { requireContractAddress } from "../contractAddresses.js";
import {
  clearHttpRpcMockGroup,
  setHttpRpcErrorMock,
  setHttpRpcMock,
  setHttpRpcRawMock,
} from "./http-test-mocks.js";
import type {
  BreakerDefaults,
  BreakerFeedState,
  BreakerKindRpc,
} from "./breakers.js";

export function registerMockBreakerListHttp(
  chainId: number,
  breakers: string[] | null,
): void {
  const breakerBoxAddress = safeBreakerBox(chainId);
  if (!breakerBoxAddress) return;
  if (breakers === null) {
    setHttpRpcErrorMock({
      group: "breakerList",
      chainId,
      address: breakerBoxAddress,
      functionName: "getBreakers",
    });
    return;
  }
  setHttpRpcMock({
    group: "breakerList",
    chainId,
    address: breakerBoxAddress,
    functionName: "getBreakers",
    result: breakers,
  });
}

export function registerMockBreakerKindHttp(
  chainId: number,
  breakerAddress: string,
  kind: BreakerKindRpc | null,
): void {
  const probeAddr = "0x0000000000000000000000000000000000000001";
  if (kind === "MEDIAN_DELTA") {
    setHttpRpcMock({
      group: "breakerKind",
      chainId,
      address: breakerAddress,
      functionName: "medianRatesEMA",
      callArgs: [probeAddr],
      result: 0n,
    });
    return;
  }
  setHttpRpcRawMock({
    group: "breakerKind",
    chainId,
    address: breakerAddress,
    functionName: "medianRatesEMA",
    callArgs: [probeAddr],
    result: "0x",
  });
  if (kind === "VALUE_DELTA") {
    setHttpRpcMock({
      group: "breakerKind",
      chainId,
      address: breakerAddress,
      functionName: "referenceValues",
      callArgs: [probeAddr],
      result: 0n,
    });
    return;
  }
  setHttpRpcRawMock({
    group: "breakerKind",
    chainId,
    address: breakerAddress,
    functionName: "referenceValues",
    callArgs: [probeAddr],
    result: "0x",
  });
}

export function registerMockBreakerDefaultsHttp(
  chainId: number,
  breakerAddress: string,
  defaults: BreakerDefaults | null,
): void {
  const breakerBoxAddress = safeBreakerBox(chainId);
  if (!breakerBoxAddress) return;
  if (defaults === null) {
    for (const [address, functionName] of [
      [breakerBoxAddress, "breakerTradingMode"],
      [breakerAddress, "defaultCooldownTime"],
      [breakerAddress, "defaultRateChangeThreshold"],
    ] as const) {
      setHttpRpcErrorMock({
        group: "breakerDefaults",
        chainId,
        address,
        functionName,
      });
    }
    return;
  }
  setHttpRpcMock({
    group: "breakerDefaults",
    chainId,
    address: breakerBoxAddress,
    functionName: "breakerTradingMode",
    callArgs: [breakerAddress],
    result: defaults.activatesTradingMode,
  });
  setHttpRpcMock({
    group: "breakerDefaults",
    chainId,
    address: breakerAddress,
    functionName: "defaultCooldownTime",
    result: defaults.defaultCooldownTime,
  });
  setHttpRpcMock({
    group: "breakerDefaults",
    chainId,
    address: breakerAddress,
    functionName: "defaultRateChangeThreshold",
    result: defaults.defaultRateChangeThreshold,
  });
}

export function registerMockBreakerFeedStateHttp(
  chainId: number,
  breakerAddress: string,
  rateFeedID: string,
  state: BreakerFeedState | null,
): void {
  const breakerBoxAddress = safeBreakerBox(chainId);
  if (!breakerBoxAddress) return;
  if (state === null) {
    setHttpRpcErrorMock({
      group: "breakerFeedState",
      chainId,
      address: breakerBoxAddress,
      functionName: "rateFeedBreakerStatus",
      callArgs: [rateFeedID, breakerAddress],
    });
    return;
  }
  setHttpRpcMock({
    group: "breakerFeedState",
    chainId,
    address: breakerBoxAddress,
    functionName: "rateFeedBreakerStatus",
    callArgs: [rateFeedID, breakerAddress],
    result: [state.tradingMode, state.lastStatusUpdatedAt, state.enabled],
  });
  for (const [functionName, result] of [
    ["rateFeedCooldownTime", state.cooldownTime],
    ["rateChangeThreshold", state.rateChangeThreshold],
    ["smoothingFactors", state.smoothingFactor ?? 0n],
    ["medianRatesEMA", state.medianRatesEMA ?? 0n],
    ["referenceValues", state.referenceValue ?? 0n],
  ] as const) {
    setHttpRpcMock({
      group: "breakerFeedState",
      chainId,
      address: breakerAddress,
      functionName,
      callArgs: [rateFeedID],
      result,
    });
  }
}

export function clearBreakerHttpMocks(): void {
  for (const group of [
    "breakerKind",
    "breakerDefaults",
    "breakerFeedState",
    "breakerList",
  ]) {
    clearHttpRpcMockGroup(group);
  }
}

function safeBreakerBox(chainId: number): string | null {
  try {
    return requireContractAddress(chainId, "BreakerBox");
  } catch {
    return null;
  }
}
