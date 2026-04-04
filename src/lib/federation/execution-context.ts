import { AsyncLocalStorage } from "node:async_hooks";

type FederationExecutionContext = {
  actorId: string;
  source: "federation";
  forceLocal: boolean;
};

const federationExecutionStorage = new AsyncLocalStorage<FederationExecutionContext>();

export async function runWithFederationExecutionContext<T>(
  actorId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return federationExecutionStorage.run(
    {
      actorId,
      source: "federation",
      forceLocal: true,
    },
    fn,
  );
}

export function getFederationExecutionContext(): FederationExecutionContext | undefined {
  return federationExecutionStorage.getStore();
}
