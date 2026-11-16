export const TABLE_COUNT = 20;

export function allTableNumbers(): string[] {
  return Array.from({ length: TABLE_COUNT }, (_, i) => String(i + 1));
}
