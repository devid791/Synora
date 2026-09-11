import { z } from "zod";
export const localMemoryProfileSchema = z.enum([
  "lean",
  "balanced",
  "expanded",
]);
export type LocalMemoryProfile = z.infer<typeof localMemoryProfileSchema>;

/** SQLite's local page-cache target, not a RAM reservation or Core heap limit. */
export function localCacheKiB(
  profile: LocalMemoryProfile,
  physicalBytes: number,
): number {
  const target = { lean: 64, balanced: 256, expanded: 1024 }[profile] * 1024;
  // Leave at least 15/16 of host RAM outside this cache target.
  return Math.max(
    1024,
    Math.floor(Math.min(target, physicalBytes / 16 / 1024)),
  );
}
export interface LocalMemoryStatus {
  profile: LocalMemoryProfile;
  cacheTargetBytes: number;
  storageDirectory: string;
  physicalMemoryBytes: number;
  heapUsedBytes: number;
  heapLimitBytes: number;
}
