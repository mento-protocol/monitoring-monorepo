export type PoolMeta = ReadonlyMap<
  string,
  { token0: string | null; token1: string | null }
>;

export type VolumePoolRow = {
  id: string;
  chainId: number;
  token0: string | null;
  token1: string | null;
};
