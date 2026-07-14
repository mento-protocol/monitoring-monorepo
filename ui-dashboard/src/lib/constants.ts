export const ENVIO_MAX_ROWS = 1000;

export const DEFAULT_PAGE_SIZE = 25;

// Default Recent Swaps limit on /pools — mirrors `LimitSelect`'s options
// ([10, 25, 50, 100]) default. Shared by `pools-page-client.tsx`'s URL
// `?limit=` fallback and `pools/loading.tsx`'s route-loading skeleton, which
// can't read the URL param and reserves the common case instead.
export const DEFAULT_SWAPS_LIMIT = 25;

export const SEARCH_BOOTSTRAP_LIMIT = 500;
export const SEARCH_MAX_LIMIT = 2000;
