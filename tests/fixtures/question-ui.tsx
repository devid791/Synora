// Explicit UI fixture: no model, account, filesystem or network operation.
import { createRoot } from "react-dom/client";
import { UserQuestion } from "../../src/renderer/UserQuestion";
import type { DesktopAPI, EngineSnapshot } from "../../src/shared/contracts";
const state = window as unknown as {
  fixtureCalls: unknown[];
  fixtureComplete: boolean;
};
state.fixtureCalls = [];
state.fixtureComplete = false;
const api = {
  engineAnswer: async (id: string, answers: Record<string, string[]>) => {
    state.fixtureCalls.push({ id, answers });
    await new Promise((r) => setTimeout(r, 150));
    if (state.fixtureCalls.length === 1)
      return {
        ok: false,
        error: {
          code: "FIXTURE_ERROR",
          message: "Controlled retry: no answer accepted",
        },
      };
    return {
      ok: true,
      value: { sequence: 10, status: "running", questions: [] },
    };
  },
} as unknown as DesktopAPI;
createRoot(document.getElementById("root")!).render(
  <UserQuestion
    request={{
      id: "fixture-ui-request",
      params: {
        threadId: "fixture-thread",
        turnId: "fixture-turn",
        itemId: "fixture-item",
        isBlocking: true,
        autoResolutionMs: null,
        questions: [
          {
            id: "choice",
            header: "Choice",
            question: "Choose an approach",
            isOther: true,
            isSecret: false,
            options: [
              { label: "A", description: "First supported option" },
              { label: "B", description: "Second supported option" },
            ],
          },
          {
            id: "private",
            header: "Private",
            question: "Fixture-only private text",
            isOther: true,
            isSecret: true,
            options: null,
          },
        ],
      },
    }}
    api={api}
    updated={(s: EngineSnapshot) => {
      state.fixtureComplete = s.status === "running";
    }}
  />,
);
