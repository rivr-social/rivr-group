import { AsyncLocalStorage } from "node:async_hooks";

export type FederationExecutionContext = {
  actorId: string;
  source: "federation" | "mcp";
  forceLocal: boolean;
  controllerId?: string;
  actorType?: "human" | "persona" | "autobot";
};

const federationExecutionStorage = new AsyncLocalStorage<FederationExecutionContext>();

export async function runWithExecutionContext<T>(
  context: FederationExecutionContext,
  fn: () => Promise<T>,
): Promise<T> {
  return federationExecutionStorage.run(context, fn);
}

export async function runWithFederationExecutionContext<T>(
  actorId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return runWithExecutionContext(
    {
      actorId,
      source: "federation",
      forceLocal: true,
    },
    fn,
  );
}

export async function runWithMcpExecutionContext<T>(
  context: {
    actorId: string;
    controllerId?: string;
    actorType?: "human" | "persona" | "autobot";
  },
  fn: () => Promise<T>,
): Promise<T> {
  return runWithExecutionContext(
    {
      actorId: context.actorId,
      controllerId: context.controllerId,
      actorType: context.actorType,
      source: "mcp",
      forceLocal: true,
    },
    fn,
  );
}

export function getFederationExecutionContext(): FederationExecutionContext | undefined {
  return federationExecutionStorage.getStore();
}

export function getExecutionContext(): FederationExecutionContext | undefined {
  return federationExecutionStorage.getStore();
}
