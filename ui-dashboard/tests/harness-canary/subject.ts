/**
 * Fixture for the mutation-testing harness canary.
 *
 * Every mutant Stryker can produce here is killed by `subject.test.ts`, so the
 * canary scores 100% whenever the harness still activates mutants. Keep it
 * trivial: a survivor must mean a broken harness, never a weak test.
 */

export function canarySum(first: number, second: number): number {
  return first + second;
}

export function canaryLabel(active: boolean): string {
  return active ? "on" : "off";
}
