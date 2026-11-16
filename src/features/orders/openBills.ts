/**
 * Which open bill a cart is adding to.
 *
 * One open bill on the table is unambiguous and preselected. With two or more
 * the staff picks explicitly; nothing is guessed, because appending a course to
 * the wrong guest's bill is a money error that is awkward to unwind.
 */

export interface OpenBillOption {
  id: number;
  orderNumber: string;
  status: string;
  total: number;
  items?: { quantity: number; itemNameEn: string; itemNameAm: string | null; itemNameOm?: string | null; status?: string }[];
}

/** "20261116-004" → "004" (what the kitchen tickets show). */
export function shortOrderNumber(orderNumber: string): string {
  const parts = orderNumber.split('-');
  return parts[parts.length - 1] || orderNumber;
}

export function resolveAppendTarget<T extends { id: number }>(
  bills: T[],
  current: T | null,
): T | null {
  if (bills.length === 0) return null;
  if (bills.length === 1) return bills[0];
  if (current) return bills.find((bill) => bill.id === current.id) ?? null;
  return null;
}
