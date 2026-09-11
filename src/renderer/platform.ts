import type { DesktopAPI } from "../shared/contracts";
import { webAPI } from "./web-api";
// Renderer code depends on the platform contract, never on Electron imports.
export function platformAPI(): DesktopAPI {
  if (window.synora) return window.synora;
  return webAPI();
}
