// Generate the marker in the shell so command echo alone cannot pass the test.
export function terminalMarker(marker: string, exitCode?: number): string {
  if (!/^[A-Z_]+$/.test(marker)) throw new Error("Invalid PTY fixture marker");
  const command =
    process.platform === "win32"
      ? `Write-Output (-join [char[]]@(${[...marker].map((c) => c.charCodeAt(0)).join(",")}))`
      : `printf '${[...marker].map((c) => "\\" + c.charCodeAt(0).toString(8).padStart(3, "0")).join("")}'`;
  return command + (exitCode === undefined ? "" : `; exit ${exitCode}`);
}
export const terminalSleep =
  process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 30";
