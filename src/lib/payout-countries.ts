export type PayoutRail = "domestic" | "connect_cross_border" | "global_payouts";

const CONNECT_REGION = new Set([
  "US", "GB", "CA", "CH",
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
  "HU", "IS", "IE", "IT", "LV", "LI", "LT", "LU", "MT", "NL", "NO", "PL",
  "PT", "RO", "SK", "SI", "ES", "SE",
]);

export function railForCountry(country: string): PayoutRail {
  const code = country.toUpperCase();
  if (code === "US") return "domestic";
  if (CONNECT_REGION.has(code)) return "connect_cross_border";
  return "global_payouts";
}

export function payoutRailNote(rail: PayoutRail): string {
  switch (rail) {
    case "domestic":
      return "You'll onboard a Stripe account and get paid to your US bank.";
    case "connect_cross_border":
      return "You'll onboard a Stripe account and get paid to your local bank.";
    case "global_payouts":
      return "You'll add local bank details and get paid in your local currency.";
  }
}

export const PAYOUT_COUNTRY_OPTIONS = [
  { code: "US", name: "United States" },
  { code: "AU", name: "Australia" },
  { code: "AT", name: "Austria" },
  { code: "BE", name: "Belgium" },
  { code: "BR", name: "Brazil" },
  { code: "CA", name: "Canada" },
  { code: "CR", name: "Costa Rica" },
  { code: "DK", name: "Denmark" },
  { code: "FI", name: "Finland" },
  { code: "FR", name: "France" },
  { code: "DE", name: "Germany" },
  { code: "IN", name: "India" },
  { code: "IE", name: "Ireland" },
  { code: "IT", name: "Italy" },
  { code: "MX", name: "Mexico" },
  { code: "NL", name: "Netherlands" },
  { code: "NO", name: "Norway" },
  { code: "PT", name: "Portugal" },
  { code: "ES", name: "Spain" },
  { code: "SE", name: "Sweden" },
  { code: "CH", name: "Switzerland" },
  { code: "GB", name: "United Kingdom" },
] as const;
