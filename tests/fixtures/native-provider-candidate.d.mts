export interface CandidateFile {
  path: string;
  sha256: string;
}
export interface NativeProviderPlan {
  candidate: string;
  platform: string;
  root: string;
  config: string;
  executable: string;
  files: CandidateFile[];
  qaHome?: string;
  core?: string;
  launcher?: string;
}
export const providerConfigs: readonly string[];
export function candidatePlan(
  candidate: string,
  platform: string,
  directory: string,
  config: string,
): NativeProviderPlan;
export function verifyCandidateFiles(
  plan: NativeProviderPlan,
  inspect?: (path: string) => Promise<{
    regular: boolean;
    linked: boolean;
    sha256: string;
  }>,
): Promise<NativeProviderPlan>;
