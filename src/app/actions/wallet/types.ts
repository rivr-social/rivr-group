export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const ETH_TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

export function getAcceptedCurrencies(metadata: Record<string, unknown>): string[] {
  const raw = metadata.acceptedCurrencies;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((value) => (typeof value === 'string' ? value.trim().toUpperCase() : ''))
    .filter((value): value is string => value.length > 0);
}

export function getAvailableInventory(metadata: Record<string, unknown>): {
  quantityAvailable: number | null;
  quantitySold: number;
  quantityRemaining: number | null;
} {
  const quantityAvailable =
    typeof metadata.quantityAvailable === 'number' && Number.isFinite(metadata.quantityAvailable)
      ? metadata.quantityAvailable
      : null;
  const quantitySold =
    typeof metadata.quantitySold === 'number' && Number.isFinite(metadata.quantitySold)
      ? metadata.quantitySold
      : 0;
  const quantityRemaining =
    typeof metadata.quantityRemaining === 'number' && Number.isFinite(metadata.quantityRemaining)
      ? metadata.quantityRemaining
      : quantityAvailable != null
        ? Math.max(quantityAvailable - quantitySold, 0)
        : null;

  return { quantityAvailable, quantitySold, quantityRemaining };
}
