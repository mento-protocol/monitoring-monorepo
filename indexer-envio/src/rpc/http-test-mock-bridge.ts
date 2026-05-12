import { requireContractAddress } from "../contractAddresses.js";

type SetTestRpcMockArgs = {
  group: string;
  chainId: number;
  address: string;
  functionName: string;
  callArgs?: readonly unknown[];
  result: unknown;
};

type SetTestRpcErrorMockArgs = {
  group: string;
  chainId: number;
  address: string;
  functionName: string;
  callArgs?: readonly unknown[];
  message?: string;
};

type SetTestRpcRawMockArgs = {
  group: string;
  chainId: number;
  address: string;
  functionName: string;
  callArgs?: readonly unknown[];
  result: string;
};

type SetTestGetCodeMockArgs = {
  group: string;
  chainId: number;
  address: string;
  result: string;
};

type SetTestGetCodeErrorMockArgs = {
  group: string;
  chainId: number;
  address: string;
  message?: string;
};

export type HttpTestRpcHandlers = {
  setHttpRpcMock: (args: SetTestRpcMockArgs) => void;
  setHttpRpcErrorMock: (args: SetTestRpcErrorMockArgs) => void;
  setHttpRpcRawMock: (args: SetTestRpcRawMockArgs) => void;
  setHttpGetCodeMock: (args: SetTestGetCodeMockArgs) => void;
  setHttpGetCodeErrorMock: (args: SetTestGetCodeErrorMockArgs) => void;
  clearHttpRpcMockGroup: (group: string) => void;
  clearHttpRpcMockGroupPrefix: (prefix: string) => void;
};

let handlers: HttpTestRpcHandlers | undefined;

export function registerHttpTestRpcHandlers(next: HttpTestRpcHandlers): void {
  handlers = next;
}

export function setTestRpcMock(args: SetTestRpcMockArgs): void {
  handlers?.setHttpRpcMock(args);
}

export function setTestRpcErrorMock(args: SetTestRpcErrorMockArgs): void {
  handlers?.setHttpRpcErrorMock(args);
}

export function setTestRpcRawMock(args: SetTestRpcRawMockArgs): void {
  handlers?.setHttpRpcRawMock(args);
}

export function setTestGetCodeMock(args: SetTestGetCodeMockArgs): void {
  handlers?.setHttpGetCodeMock(args);
}

export function setTestGetCodeErrorMock(
  args: SetTestGetCodeErrorMockArgs,
): void {
  handlers?.setHttpGetCodeErrorMock(args);
}

export function clearTestRpcMockGroup(group: string): void {
  handlers?.clearHttpRpcMockGroup(group);
}

export function clearTestRpcMockGroupPrefix(prefix: string): void {
  handlers?.clearHttpRpcMockGroupPrefix(prefix);
}

type MockRebalancingState = {
  oraclePriceNumerator: bigint;
  oraclePriceDenominator: bigint;
  rebalanceThreshold: number;
  priceDifference: bigint;
};

type MockReserves = {
  reserve0: bigint;
  reserve1: bigint;
};

type MockRebalanceThresholds = {
  above: number;
  below: number;
};

export function registerMockRebalancingStateHttp(
  chainId: number,
  poolAddress: string,
  state: MockRebalancingState | null,
): void {
  if (state === null) {
    setTestRpcErrorMock({
      group: "rebalancingState",
      chainId,
      address: poolAddress,
      functionName: "getRebalancingState",
    });
    return;
  }
  setTestRpcMock({
    group: "rebalancingState",
    chainId,
    address: poolAddress,
    functionName: "getRebalancingState",
    result: [
      state.oraclePriceNumerator,
      state.oraclePriceDenominator,
      0n,
      0n,
      false,
      state.rebalanceThreshold,
      state.priceDifference,
    ],
  });
}

export function registerMockReservesHttp(
  chainId: number,
  poolAddress: string,
  reserves: MockReserves | null,
): void {
  if (reserves === null) {
    setTestRpcErrorMock({
      group: "reserves",
      chainId,
      address: poolAddress,
      functionName: "getReserves",
    });
    return;
  }
  setTestRpcMock({
    group: "reserves",
    chainId,
    address: poolAddress,
    functionName: "getReserves",
    result: [reserves.reserve0, reserves.reserve1, 0n],
  });
}

export function registerMockERC20DecimalsHttp(
  chainId: number,
  tokenAddress: string,
  decimals: number,
): void {
  setTestRpcMock({
    group: "erc20Decimals",
    chainId,
    address: tokenAddress,
    functionName: "decimals",
    result: decimals,
  });
}

export function registerMockTokenDecimalsScalingHttp(
  chainId: number,
  poolAddress: string,
  fn: "decimals0" | "decimals1",
  value: bigint | null,
): void {
  if (value === null) {
    setTestRpcErrorMock({
      group: "tokenDecimalsScaling",
      chainId,
      address: poolAddress,
      functionName: fn,
    });
    return;
  }
  setTestRpcMock({
    group: "tokenDecimalsScaling",
    chainId,
    address: poolAddress,
    functionName: fn,
    result: value,
  });
}

export function registerMockRebalanceThresholdsHttp(
  chainId: number,
  poolAddress: string,
  thresholds: MockRebalanceThresholds | null,
): void {
  if (thresholds === null) {
    for (const functionName of [
      "rebalanceThresholdAbove",
      "rebalanceThresholdBelow",
    ] as const) {
      setTestRpcErrorMock({
        group: "rebalanceThresholds",
        chainId,
        address: poolAddress,
        functionName,
      });
    }
    return;
  }
  setTestRpcMock({
    group: "rebalanceThresholds",
    chainId,
    address: poolAddress,
    functionName: "rebalanceThresholdAbove",
    result: BigInt(thresholds.above),
  });
  setTestRpcMock({
    group: "rebalanceThresholds",
    chainId,
    address: poolAddress,
    functionName: "rebalanceThresholdBelow",
    result: BigInt(thresholds.below),
  });
}

export function clearPoolStateHttpMocks(group: string): void {
  clearTestRpcMockGroup(group);
}

type BreakerKindRpc = "MEDIAN_DELTA" | "VALUE_DELTA" | "MARKET_HOURS";

type BreakerDefaults = {
  activatesTradingMode: number;
  defaultCooldownTime: bigint;
  defaultRateChangeThreshold: bigint;
};

type BreakerFeedState = {
  tradingMode: number;
  lastStatusUpdatedAt: bigint;
  enabled: boolean;
  cooldownTime: bigint;
  rateChangeThreshold: bigint;
  smoothingFactor: bigint | null;
  medianRatesEMA: bigint | null;
  referenceValue: bigint | null;
};

export function registerMockBreakerListHttp(
  chainId: number,
  breakers: string[] | null,
): void {
  const breakerBoxAddress = safeBreakerBox(chainId);
  if (!breakerBoxAddress) return;
  if (breakers === null) {
    setTestRpcErrorMock({
      group: "breakerList",
      chainId,
      address: breakerBoxAddress,
      functionName: "getBreakers",
    });
    return;
  }
  setTestRpcMock({
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
    setTestRpcMock({
      group: "breakerKind",
      chainId,
      address: breakerAddress,
      functionName: "medianRatesEMA",
      callArgs: [probeAddr],
      result: 0n,
    });
    return;
  }
  setTestRpcRawMock({
    group: "breakerKind",
    chainId,
    address: breakerAddress,
    functionName: "medianRatesEMA",
    callArgs: [probeAddr],
    result: "0x",
  });
  if (kind === "VALUE_DELTA") {
    setTestRpcMock({
      group: "breakerKind",
      chainId,
      address: breakerAddress,
      functionName: "referenceValues",
      callArgs: [probeAddr],
      result: 0n,
    });
    return;
  }
  setTestRpcRawMock({
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
      setTestRpcErrorMock({
        group: "breakerDefaults",
        chainId,
        address,
        functionName,
        callArgs:
          functionName === "breakerTradingMode" ? [breakerAddress] : undefined,
      });
    }
    return;
  }
  setTestRpcMock({
    group: "breakerDefaults",
    chainId,
    address: breakerBoxAddress,
    functionName: "breakerTradingMode",
    callArgs: [breakerAddress],
    result: defaults.activatesTradingMode,
  });
  setTestRpcMock({
    group: "breakerDefaults",
    chainId,
    address: breakerAddress,
    functionName: "defaultCooldownTime",
    result: defaults.defaultCooldownTime,
  });
  setTestRpcMock({
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
    setTestRpcErrorMock({
      group: "breakerFeedState",
      chainId,
      address: breakerBoxAddress,
      functionName: "rateFeedBreakerStatus",
      callArgs: [rateFeedID, breakerAddress],
    });
    return;
  }
  setTestRpcMock({
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
    setTestRpcMock({
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
    clearTestRpcMockGroup(group);
  }
}

function safeBreakerBox(chainId: number): string | null {
  try {
    return requireContractAddress(chainId, "BreakerBox");
  } catch {
    return null;
  }
}
