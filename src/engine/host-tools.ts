import type { DynamicToolCallParams } from "../protocol/codex-0.153.4/v2/DynamicToolCallParams";
import type { DynamicToolCallResponse } from "../protocol/codex-0.153.4/v2/DynamicToolCallResponse";

/** Host-owned extensions to the original Core. No arbitrary renderer handler. */
export interface HostTools {
  catalog: Array<{
    type: "function";
    name: string;
    description: string;
    inputSchema: unknown;
  }>;
  instructions?: string;
  call(
    params: DynamicToolCallParams,
    signal: AbortSignal,
  ): Promise<DynamicToolCallResponse>;
}
