/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cutoffFromQueryIdentity,
  dataMatchesCurrentActor,
  rangeFromQueryIdentity,
  useResolvedQueryIdentity,
  useVersionedVolumeQueryData,
  volumeQueryIdentity,
  type VolumeQueryIdentity,
} from "../use-resolved-query-identity";

type ResultState = {
  data: unknown;
  error: unknown;
  isLoading: boolean;
};

function Probe({
  result,
  identity,
  fallbackMatchesCurrent = false,
  enabled = true,
  resultRef,
}: {
  result: ResultState;
  identity: string;
  fallbackMatchesCurrent?: boolean;
  enabled?: boolean;
  resultRef: { current: string | undefined };
}) {
  resultRef.current = useResolvedQueryIdentity(result, identity, {
    enabled,
    fallbackMatchesCurrent,
  });
  return null;
}

type VersionedResult = ReturnType<
  typeof useVersionedVolumeQueryData<{ rows: string[] }>
>;

function VersionedProbe({
  result,
  identity,
  enabled = true,
  resultRef,
}: {
  result: ResultState & { data: { rows: string[] } | undefined };
  identity: VolumeQueryIdentity;
  enabled?: boolean;
  resultRef: { current: VersionedResult | null };
}) {
  resultRef.current = useVersionedVolumeQueryData(result, identity, {
    enabled,
  });
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useResolvedQueryIdentity", () => {
  it("keeps retained data paired with its last successful key through loading and error", () => {
    const resultRef: { current: string | undefined } = { current: undefined };
    const priorData = { rows: ["prior"] };

    act(() => {
      root.render(
        <Probe
          result={{ data: priorData, error: null, isLoading: false }}
          identity="30d|organic"
          resultRef={resultRef}
        />,
      );
    });
    expect(resultRef.current).toBe("30d|organic");

    act(() => {
      root.render(
        <Probe
          result={{ data: priorData, error: null, isLoading: true }}
          identity="90d|organic"
          resultRef={resultRef}
        />,
      );
    });
    expect(resultRef.current).toBe("30d|organic");

    act(() => {
      root.render(
        <Probe
          result={{
            data: priorData,
            error: new Error("replacement failed"),
            isLoading: false,
          }}
          identity="90d|organic"
          resultRef={resultRef}
        />,
      );
    });
    expect(resultRef.current).toBe("30d|organic");

    act(() => {
      root.render(
        <Probe
          result={{ data: { rows: ["next"] }, error: null, isLoading: false }}
          identity="90d|organic"
          resultRef={resultRef}
        />,
      );
    });
    expect(resultRef.current).toBe("90d|organic");
  });

  it("recognises descriptor-validated SSR fallback as current-key data", () => {
    const resultRef: { current: string | undefined } = { current: undefined };

    act(() => {
      root.render(
        <Probe
          result={{ data: { rows: [] }, error: null, isLoading: true }}
          identity="7d|organic"
          fallbackMatchesCurrent
          resultRef={resultRef}
        />,
      );
    });

    expect(resultRef.current).toBe("7d|organic");
  });

  it("does not stamp descriptor fallback while its query is disabled", () => {
    const resultRef: { current: string | undefined } = { current: undefined };

    act(() => {
      root.render(
        <Probe
          result={{ data: { rows: [] }, error: null, isLoading: true }}
          identity="90d|organic"
          fallbackMatchesCurrent
          enabled={false}
          resultRef={resultRef}
        />,
      );
    });

    expect(resultRef.current).toBeUndefined();
  });

  it("retains ranges but rejects retained data across actor-filter identities", () => {
    const retainedOrganic = volumeQueryIdentity({
      range: "30d",
      cutoff: 100,
      includeProtocolActors: false,
    });
    const widerOrganic = volumeQueryIdentity({
      range: "90d",
      cutoff: 50,
      includeProtocolActors: false,
    });
    const widerAll = volumeQueryIdentity({
      range: "90d",
      cutoff: 50,
      includeProtocolActors: true,
    });

    expect(dataMatchesCurrentActor(retainedOrganic, widerOrganic)).toBe(true);
    expect(rangeFromQueryIdentity(retainedOrganic)).toBe("30d");
    expect(cutoffFromQueryIdentity(retainedOrganic)).toBe(100);
    expect(dataMatchesCurrentActor(retainedOrganic, widerAll)).toBe(false);
  });

  it("keeps range-retained rows through replacement errors but hides them on actor changes", () => {
    const resultRef: { current: VersionedResult | null } = { current: null };
    const retainedData = { rows: ["prior complete window"] };
    const priorOrganic = volumeQueryIdentity({
      range: "30d",
      cutoff: 100,
      includeProtocolActors: false,
    });
    const widerOrganic = volumeQueryIdentity({
      range: "90d",
      cutoff: 50,
      includeProtocolActors: false,
    });
    const widerAll = volumeQueryIdentity({
      range: "90d",
      cutoff: 50,
      includeProtocolActors: true,
    });

    act(() => {
      root.render(
        <VersionedProbe
          result={{ data: retainedData, error: null, isLoading: false }}
          identity={priorOrganic}
          resultRef={resultRef}
        />,
      );
    });

    act(() => {
      root.render(
        <VersionedProbe
          result={{ data: retainedData, error: null, isLoading: true }}
          identity={widerOrganic}
          resultRef={resultRef}
        />,
      );
    });
    expect(resultRef.current).toMatchObject({
      data: retainedData,
      dataIdentity: priorOrganic,
      isLoading: false,
      hasError: false,
    });

    act(() => {
      root.render(
        <VersionedProbe
          result={{
            data: retainedData,
            error: new Error("new range failed"),
            isLoading: false,
          }}
          identity={widerOrganic}
          resultRef={resultRef}
        />,
      );
    });
    expect(resultRef.current).toMatchObject({
      data: retainedData,
      hasError: false,
    });

    act(() => {
      root.render(
        <VersionedProbe
          result={{ data: retainedData, error: null, isLoading: true }}
          identity={widerAll}
          resultRef={resultRef}
        />,
      );
    });
    expect(resultRef.current).toMatchObject({
      data: undefined,
      isLoading: true,
      hasError: false,
    });

    act(() => {
      root.render(
        <VersionedProbe
          result={{
            data: retainedData,
            error: new Error("actor-filter request failed"),
            isLoading: false,
          }}
          identity={widerAll}
          resultRef={resultRef}
        />,
      );
    });
    expect(resultRef.current).toMatchObject({
      data: undefined,
      isLoading: false,
      hasError: true,
    });
  });

  it("does not restamp retained v2 data while its venue query is disabled", () => {
    const resultRef: { current: VersionedResult | null } = { current: null };
    const staleV2Data = { rows: ["v2 organic 30d"] };
    const v2Organic30d = volumeQueryIdentity({
      range: "30d",
      cutoff: 100,
      includeProtocolActors: false,
    });
    const v2All90d = volumeQueryIdentity({
      range: "90d",
      cutoff: 50,
      includeProtocolActors: true,
    });

    // Resolve v2 Organic/30d, then switch to v3. The disabled v2 SWR hook
    // still exposes its last response with `isLoading: false`.
    act(() => {
      root.render(
        <VersionedProbe
          result={{ data: staleV2Data, error: null, isLoading: false }}
          identity={v2Organic30d}
          resultRef={resultRef}
        />,
      );
    });
    expect(resultRef.current).toMatchObject({
      data: staleV2Data,
      dataIdentity: v2Organic30d,
    });

    act(() => {
      root.render(
        <VersionedProbe
          result={{ data: staleV2Data, error: null, isLoading: false }}
          identity={v2Organic30d}
          enabled={false}
          resultRef={resultRef}
        />,
      );
    });

    // Change both range and actor scope while v2 remains disabled. Its old
    // response must keep the identity it actually resolved under.
    act(() => {
      root.render(
        <VersionedProbe
          result={{ data: staleV2Data, error: null, isLoading: false }}
          identity={v2All90d}
          enabled={false}
          resultRef={resultRef}
        />,
      );
    });
    expect(resultRef.current).toMatchObject({
      data: undefined,
      dataIdentity: v2Organic30d,
      isLoading: false,
      hasError: false,
    });

    // Switching back to v2 starts the new key. The retained Organic/30d rows
    // stay withheld instead of being mislabeled as All/90d.
    act(() => {
      root.render(
        <VersionedProbe
          result={{ data: staleV2Data, error: null, isLoading: true }}
          identity={v2All90d}
          resultRef={resultRef}
        />,
      );
    });
    expect(resultRef.current).toMatchObject({
      data: undefined,
      dataIdentity: v2Organic30d,
      isLoading: true,
      hasError: false,
    });

    const freshV2Data = { rows: ["v2 all 90d"] };
    act(() => {
      root.render(
        <VersionedProbe
          result={{ data: freshV2Data, error: null, isLoading: false }}
          identity={v2All90d}
          resultRef={resultRef}
        />,
      );
    });
    expect(resultRef.current).toMatchObject({
      data: freshV2Data,
      dataIdentity: v2All90d,
      isLoading: false,
      hasError: false,
    });
  });

  it("keeps the prior range identity across a same-actor disabled venue transition", () => {
    const resultRef: { current: VersionedResult | null } = { current: null };
    const retainedV2Data = { rows: ["v2 organic 30d"] };
    const v2Organic30d = volumeQueryIdentity({
      range: "30d",
      cutoff: 100,
      includeProtocolActors: false,
    });
    const v2Organic90d = volumeQueryIdentity({
      range: "90d",
      cutoff: 50,
      includeProtocolActors: false,
    });

    act(() => {
      root.render(
        <VersionedProbe
          result={{ data: retainedV2Data, error: null, isLoading: false }}
          identity={v2Organic30d}
          resultRef={resultRef}
        />,
      );
    });

    act(() => {
      root.render(
        <VersionedProbe
          result={{ data: retainedV2Data, error: null, isLoading: false }}
          identity={v2Organic90d}
          enabled={false}
          resultRef={resultRef}
        />,
      );
    });
    expect(resultRef.current).toMatchObject({
      data: undefined,
      dataIdentity: v2Organic30d,
      isLoading: false,
      hasError: false,
    });

    act(() => {
      root.render(
        <VersionedProbe
          result={{ data: retainedV2Data, error: null, isLoading: true }}
          identity={v2Organic90d}
          resultRef={resultRef}
        />,
      );
    });
    expect(resultRef.current).toMatchObject({
      data: retainedV2Data,
      dataIdentity: v2Organic30d,
      isLoading: false,
      hasError: false,
    });

    const freshV2Data = { rows: ["v2 organic 90d"] };
    act(() => {
      root.render(
        <VersionedProbe
          result={{ data: freshV2Data, error: null, isLoading: false }}
          identity={v2Organic90d}
          resultRef={resultRef}
        />,
      );
    });
    expect(resultRef.current).toMatchObject({
      data: freshV2Data,
      dataIdentity: v2Organic90d,
      isLoading: false,
      hasError: false,
    });
  });
});
