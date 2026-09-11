import { Bug, Code2, FileText, FolderSearch, ListChecks, ScanText, SearchCheck, TestTube2 } from "lucide-react";
import { useI18n } from "./i18n";
import { messages } from "./locales/conversations";

const starters = [
  { label: "Explore a project", icon: FolderSearch, prompt: "Inspect this project's files and explain its structure, entry points and how to run it. Do not change files." },
  { label: "Find a bug", icon: Bug, prompt: "Help me diagnose this problem: [describe the symptoms]. Inspect the relevant code, explain the cause and propose a fix before changing files." },
  { label: "Build a feature", icon: Code2, prompt: "Implement this feature: [describe the desired behavior]. Follow the project's conventions, preserve unrelated changes and verify the result." },
  { label: "Write tests", icon: TestTube2, prompt: "Inspect this project's existing tests and add focused coverage for [function or behavior], including edge cases. Run the relevant tests and report the results." },
  { label: "Review changes", icon: SearchCheck, prompt: "Review the current project changes for bugs, regressions and missing tests. Report concrete findings with file references; do not change files." },
  { label: "Write documentation", icon: FileText, prompt: "Prepare clear documentation for [feature or project], based on the actual implementation. Include setup, usage examples and known limitations." },
  { label: "Explain a file", icon: ScanText, prompt: "Read [file or module] and explain its purpose, main logic and dependencies. Highlight anything unclear; do not change files." },
  { label: "Plan a task", icon: ListChecks, prompt: "Help me plan [task or objective]. Inspect the available context, identify requirements and risks, and propose verifiable steps before implementation." },
] as const;

export function ConversationStarters({ draft, choose, adaptive = false }: { draft: string; choose: (value: string) => void; adaptive?: boolean }) {
  const { t } = useI18n(messages);
  return <section className={adaptive ? "adaptive-starters" : undefined} aria-label={t("Ideas to get started")}>
    <div className="welcome-grid starter-grid">{starters.map(({ label, icon: Icon, prompt }) => {
      const next = draft.trim() ? `${draft}\n\n${t(prompt)}` : t(prompt);
      return <button key={label} disabled={next.length > 100000} title={next.length > 100000 ? t("The draft is full.") : t(prompt)}
        onClick={() => choose(next)}><Icon /><span>{t(label)}</span></button>;
    })}</div>
    <p className="starter-note">{t("Choose an example, edit the placeholders and send when ready. Existing draft text is kept; nothing runs automatically.")}</p>
  </section>;
}
