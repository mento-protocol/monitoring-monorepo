export function hasErrorWithoutData<TError>(
  error: TError,
  data: unknown,
): error is NonNullable<TError> {
  return error != null && data == null;
}

export function isLoadingWithoutData(
  isLoading: boolean,
  data: unknown,
): boolean {
  return isLoading && data == null;
}
