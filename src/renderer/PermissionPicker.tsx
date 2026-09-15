import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, Hand, Shield, ShieldAlert } from "lucide-react";
import {
  permissionContract,
  type PermissionMode,
} from "../shared/permission-mode";
import { Modal } from "./Modal";
import { useI18n } from "./i18n";
import { messages } from "./locales/composer";

const choices = [
  {
    mode: "ask",
    label: "Ask for approval",
    description: "Ask you before actions that require approval.",
  },
  {
    mode: "auto-review",
    label: "Approve for me",
    description: "Automatically review approval requests; ask you when needed.",
  },
  {
    mode: "full",
    label: "Full access",
    description: "Access files, the internet, browser and desktop apps without Synora approval prompts. OS permissions still apply.",
  },
] as const;

function PermissionIcon({ mode }: { mode: PermissionMode }) {
  if (mode === "ask") return <Hand aria-hidden="true" />;
  if (mode === "full") return <ShieldAlert aria-hidden="true" />;
  return (
    <Shield aria-hidden="true">
      <path d="m9 8 3 3-3 3m4 1h3" />
    </Shield>
  );
}

export function PermissionPicker({
  mode,
  busy,
  change,
}: {
  mode: PermissionMode;
  busy: boolean;
  change: (mode: PermissionMode) => Promise<void>;
}) {
  const { t } = useI18n(messages);
  const id = useId(),
    anchor = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false),
    [confirm, setConfirm] = useState(false),
    [help, setHelp] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const applying = useRef(false);
  const disabled = busy || pending;
  const selected = choices.find((c) => c.mode === mode)!;
  const close = (restoreFocus = false) => {
    panel.current?.hidePopover();
    setOpen(false);
    if (restoreFocus) anchor.current?.focus({ preventScroll: true });
  };
  const position = () => {
    const button = anchor.current,
      popup = panel.current;
    if (!button || !popup?.matches(":popover-open")) return;
    const r = button.getBoundingClientRect(),
      gap = 8;
    const above = Math.max(0, r.top - gap * 2),
      below = Math.max(0, innerHeight - r.bottom - gap * 2);
    const desired = Math.min(popup.scrollHeight + 2, innerHeight - gap * 2);
    const up = desired <= above || above >= below;
    popup.style.maxHeight = `${Math.max(1, up ? above : below)}px`;
    popup.style.left = `${Math.max(gap, Math.min(r.left, innerWidth - popup.offsetWidth - gap))}px`;
    popup.style.top = `${up ? Math.max(gap, r.top - popup.offsetHeight - gap) : r.bottom + gap}px`;
  };
  const show = (last = false) => {
    if (disabled || !panel.current) return;
    panel.current.showPopover();
    setOpen(true);
    position();
    // Focus synchronously: the native toggle event is deferred and must not
    // steal focus from a subsequent Tab, click or dialog dismissal.
    panel.current
      .querySelector<HTMLButtonElement>(
        last ? '[data-permission-option="full"]' : '[aria-checked="true"]',
      )
      ?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!open) return;
    const observer = new ResizeObserver(position);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open]);
  useEffect(() => {
    if (disabled) close();
  }, [disabled]);
  const apply = async (value: PermissionMode) => {
    if (busy || applying.current || value === mode) return;
    applying.current = true;
    setPending(true);
    setError("");
    try {
      await change(value);
      setConfirm(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      applying.current = false;
      setPending(false);
    }
  };
  const choose = (value: PermissionMode) => {
    if (disabled) return;
    close(true);
    setError("");
    if (value === mode) return;
    if (value === "full") setConfirm(true);
    else void apply(value);
  };
  const keyboard = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key === "Tab") {
      close(true);
      return;
    }
    const items = [
      ...(panel.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitemradio"], [role="menuitem"]',
      ) ?? []),
    ];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const target =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? items.length - 1
          : e.key === "ArrowDown"
            ? (index + 1) % items.length
            : e.key === "ArrowUp"
              ? index < 0
                ? items.length - 1
                : (index + items.length - 1) % items.length
              : -1;
    if (target >= 0) {
      e.preventDefault();
      items[target]?.focus();
    }
  };
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={`permission-trigger${mode === "full" ? " permission-full" : ""}`}
        data-permission={mode}
        aria-label={`${t("Permissions")}: ${t(selected.label)}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        disabled={disabled}
        onClick={() =>
          panel.current?.matches(":popover-open") ? close() : show()
        }
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          show(e.key === "ArrowUp");
        }}
      >
        <PermissionIcon mode={mode} />
        <span>{t(selected.label)}</span>
      </button>
      <div
        ref={panel}
        id={id}
        popover="auto"
        role="menu"
        aria-label={t("Permissions")}
        className="permission-menu"
        onKeyDown={keyboard}
        onToggle={() => {
          const visible = !!panel.current?.matches(":popover-open");
          setOpen(visible);
        }}
      >
        <div className="permission-menu-heading">
          <span>{t("How should AI actions be approved?")}</span>
          <button
            type="button"
            role="menuitem"
            className="permission-learn"
            onClick={() => {
              close(true);
              setHelp(true);
            }}
          >
            {t("Learn more")}
          </button>
        </div>
        {choices.map((c) => (
          <button
            key={c.mode}
            type="button"
            role="menuitemradio"
            aria-checked={mode === c.mode}
            aria-labelledby={`${id}-${c.mode}-label`}
            aria-describedby={`${id}-${c.mode}-description`}
            data-permission-option={c.mode}
            tabIndex={mode === c.mode ? 0 : -1}
            disabled={disabled}
            className={`permission-option${c.mode === "full" ? " permission-full" : ""}`}
            onClick={() => choose(c.mode)}
          >
            <PermissionIcon mode={c.mode} />
            <span className="permission-option-copy">
              <span
                id={`${id}-${c.mode}-label`}
                className="permission-option-label"
              >
                {t(c.label)}
              </span>
              <span
                id={`${id}-${c.mode}-description`}
                className="permission-option-description"
              >
                {t(c.description)}
              </span>
            </span>
            {mode === c.mode ? (
              <Check className="permission-check" aria-hidden="true" />
            ) : (
              <span />
            )}
          </button>
        ))}
      </div>
      {error && !confirm && <span role="alert">{error}</span>}
      {help && (
        <Modal label={t("Permissions")} onDismiss={() => setHelp(false)}>
          <div className="modal permission-help">
            <h2>{t("How should AI actions be approved?")}</h2>
            {choices.map((c) => (
              <section key={c.mode}>
                <h3>{t(c.label)}</h3>
                <p>{t(c.description)}</p>
                <code>
                  {permissionContract(c.mode).approvalPolicy} ·{" "}
                  {permissionContract(c.mode).approvalsReviewer} ·{" "}
                  {permissionContract(c.mode).sandbox}
                </code>
              </section>
            ))}
            <p>
              {t(
                "Permissions apply to the next turn in this conversation. History, draft and attachments are kept; other conversations are unchanged.",
              )}
            </p>
            <button type="button" onClick={() => setHelp(false)}>
              {t("Close")}
            </button>
          </div>
        </Modal>
      )}
      {confirm && (
        <Modal
          label={t("Enable full access")}
          onDismiss={() => {
            if (!pending) setConfirm(false);
          }}
        >
          <div className="modal">
            <h2>{t("Enable full access?")}</h2>
            <p>
              {t(
                "App Server tools will run without approval prompts or the workspace sandbox, subject to this computer’s operating-system permissions. This includes files and network access.",
              )}
            </p>
            <p>
              {t(
                "Permissions apply to the next turn in this conversation. History, draft and attachments are kept; other conversations are unchanged.",
              )}
            </p>
            {error && <p role="alert">{error}</p>}
            <div className="actions">
              <button
                type="button"
                disabled={pending}
                onClick={() => setConfirm(false)}
              >
                {t("Keep current permissions")}
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => void apply("full")}
              >
                {t("Enable full access")}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
