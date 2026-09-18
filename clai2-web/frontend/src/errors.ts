/** Turn a caught value of unknown shape into a message fit to show a person. */
export function errorMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
