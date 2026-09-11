import { createRoot } from "react-dom/client";
import { AgentCard } from "../../src/renderer/AgentCard";
import type { AgentRecord } from "../../src/shared/contracts";
declare global {
  interface Window {
    ownedAgent?: AgentRecord;
    parentOpened?: string;
  }
}
const agent: AgentRecord = window.ownedAgent ?? {
  id: "fixture-child-with-long-identity",
  name: "Darwin",
  parentId: "fixture-parent-with-long-identity",
  coreSessionId: "child-core-session",
  turnId: "fixture-child-turn",
  task: "Read the owned test file",
  result: "CHILD_RESULT",
  status: "completed",
  closed: true,
  simulated: false,
  activity: [],
  backendRequests: [],
  metadataError: null,
};
createRoot(document.getElementById("root")!).render(
  <>
    <AgentCard
      agent={agent}
      openParent={() => {
        window.parentOpened = agent.parentId;
      }}
    />
    {!window.ownedAgent && (
      <AgentCard
        agent={{
          ...agent,
          id: "error-child",
          name: "Metadata pending",
          result: "",
          status: "pendingInit",
          closed: false,
          metadataError: "Fixture metadata unavailable",
        }}
        openParent={() => {}}
      />
    )}
  </>,
);
