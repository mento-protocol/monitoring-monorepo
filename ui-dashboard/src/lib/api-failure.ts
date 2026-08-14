const API_FAILURE_CLASSES = [
  "configuration",
  "http",
  "invalid-payload",
  "network",
  "timeout",
  "upstream-http",
  "upstream-rate-limit",
  "upstream-unavailable",
] as const;

export type ApiFailureClass = (typeof API_FAILURE_CLASSES)[number];

export type ApiErrorBody = {
  error: string;
  failureClass: ApiFailureClass;
  upstreamStatus?: number;
};

export function isApiFailureClass(value: unknown): value is ApiFailureClass {
  return API_FAILURE_CLASSES.some((failureClass) => failureClass === value);
}

export function isHttpStatus(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
  );
}
