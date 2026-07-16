export type GraphQLVariables = Record<string, unknown>;
export type Variables = GraphQLVariables;

export type GraphQLRequest = {
  query: string;
  variables?: GraphQLVariables | undefined;
};

type GraphQLErrorPayload = {
  message: string;
  locations?: ReadonlyArray<{ line: number; column: number }> | undefined;
  path?: ReadonlyArray<string | number> | undefined;
  extensions?: Record<string, unknown> | undefined;
};

export type GraphQLClientResponse = {
  status: number;
  headers: Headers;
  body: string;
  data?: unknown;
  errors?: ReadonlyArray<GraphQLErrorPayload> | undefined;
};

export class ClientError extends Error {
  readonly response: GraphQLClientResponse;
  readonly request: GraphQLRequest;

  constructor(response: GraphQLClientResponse, request: GraphQLRequest) {
    const details =
      response.errors?.map((error) => error.message).join("; ") ||
      `HTTP ${response.status}`;
    super(`GraphQL request failed: ${details}`);
    this.name = "ClientError";
    this.response = response;
    this.request = request;
  }
}

type GraphQLRequestOptions = {
  document: string;
  variables?: GraphQLVariables | undefined;
  signal?: AbortSignal | undefined;
};

type GraphQLResponseEnvelope<T> = {
  data?: T;
  errors?: ReadonlyArray<GraphQLErrorPayload>;
};

function normalizeRequest(
  documentOrOptions: string | GraphQLRequestOptions,
  positionalVariables?: GraphQLVariables,
): { options: GraphQLRequestOptions; request: GraphQLRequest } {
  const options: GraphQLRequestOptions =
    typeof documentOrOptions === "string"
      ? {
          document: documentOrOptions,
          ...(positionalVariables !== undefined
            ? { variables: positionalVariables }
            : {}),
        }
      : documentOrOptions;
  return {
    options,
    request: {
      query: options.document,
      ...(options.variables !== undefined
        ? { variables: options.variables }
        : {}),
    },
  };
}

function parseResponseEnvelope<T>(
  value: unknown,
): GraphQLResponseEnvelope<T> | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const rawErrors = record.errors;
  if (
    rawErrors !== undefined &&
    (!Array.isArray(rawErrors) ||
      rawErrors.some(
        (error) =>
          typeof error !== "object" ||
          error === null ||
          typeof (error as Record<string, unknown>).message !== "string",
      ))
  ) {
    return null;
  }
  return {
    ...(Object.prototype.hasOwnProperty.call(record, "data")
      ? { data: record.data as T }
      : {}),
    ...(rawErrors !== undefined
      ? { errors: rawErrors as ReadonlyArray<GraphQLErrorPayload> }
      : {}),
  };
}

/**
 * Minimal GraphQL-over-HTTP client used by both browser and server fetchers.
 * The overloads intentionally match the dashboard's two established call
 * shapes so callers can opt into AbortSignal without adapters.
 */
export class GraphQLClient {
  constructor(readonly endpoint: string) {}

  request<T>(document: string, variables?: GraphQLVariables): Promise<T>;
  request<T>(options: GraphQLRequestOptions): Promise<T>;
  async request<T>(
    documentOrOptions: string | GraphQLRequestOptions,
    positionalVariables?: GraphQLVariables,
  ): Promise<T> {
    const { options, request } = normalizeRequest(
      documentOrOptions,
      positionalVariables,
    );
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    const body = await response.text();
    let envelope: unknown;
    try {
      envelope = JSON.parse(body) as unknown;
    } catch {
      throw new ClientError(
        { status: response.status, headers: response.headers, body },
        request,
      );
    }

    const parsed = parseResponseEnvelope<T>(envelope);
    const clientResponse: GraphQLClientResponse = {
      status: response.status,
      headers: response.headers,
      body,
      ...(parsed?.data !== undefined ? { data: parsed.data } : {}),
      ...(parsed?.errors !== undefined ? { errors: parsed.errors } : {}),
    };
    if (!response.ok || parsed === null || (parsed.errors?.length ?? 0) > 0) {
      throw new ClientError(clientResponse, request);
    }
    if (parsed.data === undefined) {
      throw new ClientError(clientResponse, request);
    }
    return parsed.data;
  }
}

const clientCache = new Map<string, GraphQLClient>();

/** Reuse one client per endpoint; network changes still get isolated clients. */
export function getGraphQLClient(endpoint: string): GraphQLClient {
  const cached = clientCache.get(endpoint);
  if (cached !== undefined) return cached;
  const client = new GraphQLClient(endpoint);
  clientCache.set(endpoint, client);
  return client;
}
