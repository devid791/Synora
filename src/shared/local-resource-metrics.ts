/**
 * Host RAM reported by Node's OS API, not Synora's aggregate RAM or process RSS.
 * Non-free is total minus free, including OS/cache and other processes; it is
 * not memory pressure or an estimate of reclaimable/available memory.
 */
export type HostMemorySample =
  | {
      state: "available";
      source: "node:os";
      /** Unix epoch milliseconds at the start of this synchronous sample. */
      observedAt: number;
      totalBytes: number;
      freeBytes: number;
      nonFreeBytes: number;
    }
  | {
      state: "unavailable";
      source: "node:os";
      /** Null only when the sampling clock failed or returned an invalid value. */
      observedAt: number | null;
      reason: string;
    };
