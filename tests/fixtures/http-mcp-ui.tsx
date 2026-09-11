import { createRoot } from "react-dom/client";
import { ToolActivity } from "../../src/renderer/ToolActivity";
import type { ThreadItem } from "../../src/protocol/codex-0.153.4/v2/ThreadItem";
declare global {
  interface Window {
    ownedMcpItems: ThreadItem[];
  }
}
createRoot(document.getElementById("root")!).render(
  <>
    {window.ownedMcpItems.map((item) => (
      <ToolActivity key={item.id} item={item} simulated={false} />
    ))}
  </>,
);
