/** A group of input and expected-output pairs for one language. */
export interface GoldenGroup {
  name: string;
  cases: readonly (readonly [input: string, expected: string])[];
}
