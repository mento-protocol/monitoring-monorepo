export function isValidAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}
