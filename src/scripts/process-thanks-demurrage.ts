import { previewThanksTokenDemurrageForOwner, processAllThanksTokenDemurrage, processThanksTokenDemurrageForOwner } from "@/lib/thanks-demurrage";

function readArgValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0 || index + 1 >= process.argv.length) {
    return null;
  }
  return process.argv[index + 1];
}

async function main() {
  const ownerId = readArgValue("--owner");
  const dryRun = process.argv.includes("--dry-run");
  const at = readArgValue("--at");
  const now = at ? new Date(at) : new Date();

  if (Number.isNaN(now.getTime())) {
    throw new Error(`Invalid --at timestamp: ${at}`);
  }

  if (ownerId) {
    const result = dryRun
      ? await previewThanksTokenDemurrageForOwner(ownerId, now)
      : await processThanksTokenDemurrageForOwner(ownerId, now);

    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (dryRun) {
    throw new Error("--dry-run currently requires --owner so the preview stays explicit.");
  }

  const results = await processAllThanksTokenDemurrage(now);
  const aggregate = results.reduce(
    (acc, entry) => {
      acc.accounts += 1;
      acc.tokens += entry.tokenCount;
      acc.burned += entry.burnCount;
      acc.totalContribution += entry.totalContribution;
      return acc;
    },
    { accounts: 0, tokens: 0, burned: 0, totalContribution: 0 },
  );

  console.log(JSON.stringify({ now: now.toISOString(), aggregate, results }, null, 2));
}

void main().catch((error) => {
  console.error("[thanks-demurrage] Failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
