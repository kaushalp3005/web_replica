// Stock take's "As of" date rules, kept out of the .tsx so Node can test them
// (stock-take-as-of.test.ts). Days are "YYYY-MM-DD", which compare correctly as
// strings. An empty value means live stock.

/** A typed future day becomes today. The ledger has nothing after today, and the
 *  server would measure every count's age against the future day. */
export function clampAsOf(value: string, today: string): string {
  return value > today ? today : value;
}

/** True for a day before today. asOf=today returns exactly what no date returns,
 *  so today is still live stock and posting stays open. */
export function isPastView(asOf: string, today: string): boolean {
  return asOf !== "" && asOf < today;
}
