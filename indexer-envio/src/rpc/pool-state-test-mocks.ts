import {
  clearHttpRpcMockGroup,
  setHttpRpcErrorMock,
  setHttpRpcMock,
} from "./http-test-mocks.js";

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
    setHttpRpcErrorMock({
      group: "rebalancingState",
      chainId,
      address: poolAddress,
      functionName: "getRebalancingState",
    });
    return;
  }
  setHttpRpcMock({
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
    setHttpRpcErrorMock({
      group: "reserves",
      chainId,
      address: poolAddress,
      functionName: "getReserves",
    });
    return;
  }
  setHttpRpcMock({
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
  setHttpRpcMock({
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
    setHttpRpcErrorMock({
      group: "tokenDecimalsScaling",
      chainId,
      address: poolAddress,
      functionName: fn,
    });
    return;
  }
  setHttpRpcMock({
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
      setHttpRpcErrorMock({
        group: "rebalanceThresholds",
        chainId,
        address: poolAddress,
        functionName,
      });
    }
    return;
  }
  setHttpRpcMock({
    group: "rebalanceThresholds",
    chainId,
    address: poolAddress,
    functionName: "rebalanceThresholdAbove",
    result: BigInt(thresholds.above),
  });
  setHttpRpcMock({
    group: "rebalanceThresholds",
    chainId,
    address: poolAddress,
    functionName: "rebalanceThresholdBelow",
    result: BigInt(thresholds.below),
  });
}

export function clearPoolStateHttpMocks(group: string): void {
  clearHttpRpcMockGroup(group);
}
