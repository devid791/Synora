/** Describe the executor host, not the model server or the browser client.
 * This is guidance sent to original Core, never a rewrite of tool arguments.
 */
export function hostToolContext(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): { developerInstructions?: string } {
  if (platform !== "win32") return {};
  return {
    developerInstructions: [
      "Synora executor environment: Windows, with native Windows filesystem paths and PowerShell commands.",
      `The tool working directory is ${JSON.stringify(cwd)}. This is a filesystem path, not a URL.`,
      "Use the tools actually supplied by Core. When apply_patch is available, use workspace-relative paths in patch headers, such as src/file.txt, for workspace files.",
      "If a tool requires an absolute Windows path, its drive letter must be at the beginning (for example C:/project/src/file.txt). Do not use /C:/project/src/file.txt, file:// URLs, or append a slash to a file path.",
      "If a tool reports an invalid path, correct the path based on its error and the working directory. Do not repeat identical failed arguments or claim a file was changed before the tool succeeds.",
      "These host details do not change the tool catalog, approvals, sandbox, or user-authorized scope.",
    ].join("\n"),
  };
}
