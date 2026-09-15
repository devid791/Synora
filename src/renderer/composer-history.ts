type Message = { role: string; text: string };
type Key = {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
};

/** Text recall only. Never sends, attaches files, mutates messages or selects a
 * conversation. A fresh draft is retained until Down leaves history. */
export class ComposerHistory {
  private browsing?: {
    conversation: string;
    texts: string[];
    index: number;
    draft: string;
    shown: string;
  };
  reset() {
    this.browsing = undefined;
  }
  recall(
    conversation: string,
    messages: readonly Message[],
    value: string,
    start: number,
    end: number,
    event: Key,
  ): string | null {
    if (
      this.browsing &&
      (this.browsing.conversation !== conversation ||
        this.browsing.shown !== value)
    )
      this.reset();
    if (
      event.isComposing ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    ) {
      this.reset();
      return null;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
      this.reset();
      return null;
    }
    if (start !== end) {
      this.reset();
      return null;
    }
    if (!this.browsing) {
      // Plain arrows remain caret movement inside existing/multiline drafts.
      // Recall starts from an empty composer or the start of a single-line draft.
      if (
        !conversation ||
        event.key !== "ArrowUp" ||
        start !== 0 ||
        value.includes("\n")
      )
        return null;
      const texts = messages
        .filter((m) => m.role === "user" && m.text.trim())
        .map((m) => m.text);
      if (!texts.length) return null;
      this.browsing = {
        conversation,
        texts,
        index: texts.length,
        draft: value,
        shown: value,
      };
    }
    const state = this.browsing;
    state.index = Math.max(
      0,
      Math.min(
        state.texts.length,
        state.index + (event.key === "ArrowUp" ? -1 : 1),
      ),
    );
    if (state.index === state.texts.length) {
      this.reset();
      return state.draft;
    }
    return (state.shown = state.texts[state.index]);
  }
}
