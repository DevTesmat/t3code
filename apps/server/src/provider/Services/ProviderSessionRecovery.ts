import { Context } from "effect";
import type { Effect } from "effect";

export interface ProviderSessionRecoveryShape {
  readonly recoverStaleRunningThreads: () => Effect.Effect<void>;
}

export class ProviderSessionRecovery extends Context.Service<
  ProviderSessionRecovery,
  ProviderSessionRecoveryShape
>()("t3/provider/Services/ProviderSessionRecovery") {}
