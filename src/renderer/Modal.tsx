import { useLayoutEffect, useRef, type ReactNode } from "react";

/** Native top-layer modality: background stays inert for pointer and keyboard. */
export function Modal({
  label,
  onDismiss,
  children,
}: {
  label: string;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useLayoutEffect(() => {
    const element = dialog.current!;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    element.showModal();
    const focusable = () =>
      [
        ...element.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
        ),
      ].filter((e) => e.getClientRects().length && !e.closest("[inert]"));
    (
      element.querySelector<HTMLElement>(
        "input:not(:disabled):not([readonly]), textarea:not(:disabled)",
      ) ??
      focusable()[0] ??
      element
    ).focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const targets = focusable(),
        first = targets[0],
        last = targets.at(-1);
      if (!first) {
        event.preventDefault();
        element.focus();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === element)
      ) {
        event.preventDefault();
        last!.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || document.activeElement === element)
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    const cancel = (event: Event) => {
      event.preventDefault();
      dismiss.current();
    };
    element.addEventListener("keydown", keydown);
    element.addEventListener("cancel", cancel);
    return () => {
      element.removeEventListener("keydown", keydown);
      element.removeEventListener("cancel", cancel);
      element.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="modal-dialog"
      aria-label={label}
      aria-modal="true"
      tabIndex={-1}
    >
      {children}
    </dialog>
  );
}
