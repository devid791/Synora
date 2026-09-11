import { useEffect, useRef, useState } from "react";
import { ImageOff } from "lucide-react";
import { useI18n } from "./i18n";
import { messages } from "./locales/catalog";
import { useResolvedTheme } from "./settings-theme";
import type { DesktopAPI } from "../shared/contracts";
import type {
  CatalogIcon as IconResult,
  CatalogIconRequest,
} from "../shared/catalog-icon";

export function CatalogIcon({
  api,
  identity,
  name,
  available = true,
}: {
  api: DesktopAPI;
  identity: Omit<CatalogIconRequest, "theme">;
  name: string;
  available?: boolean;
}) {
  const { t } = useI18n(messages);
  const theme = useResolvedTheme();
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false),
    [retry, setRetry] = useState(0);
  const [result, setResult] = useState<IconResult | null>(null),
    [decodeFailed, setDecodeFailed] = useState(false),
    [transportFailed, setTransportFailed] = useState(false);
  const key = JSON.stringify(identity);
  useEffect(() => {
    setVisible(false);
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "150px" },
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [key]);
  useEffect(() => {
    setResult(null);
    setDecodeFailed(false);
    setTransportFailed(false);
    if (!visible || !available) return;
    let stopped = false;
    void api
      .coreCatalogIcon({
        ...JSON.parse(key),
        theme,
        refresh: retry > 0,
      })
      .then((r) => {
        if (!stopped)
          setResult(
            r.ok
              ? r.value
              : {
                  status: "unavailable",
                  code: r.error.code,
                  message: r.error.message,
                },
          );
      })
      .catch(() => {
        if (!stopped) {
          setTransportFailed(true);
          setResult({
            status: "unavailable",
            code: "ICON_TRANSPORT",
            message: "Could not load the original icon.",
          });
        }
      });
    return () => {
      stopped = true;
    };
  }, [api, key, visible, retry, available, theme]);
  const failed = decodeFailed || result?.status === "unavailable";
  const message = !available
    ? t("Icon unavailable until a complete catalog is selected.")
    : decodeFailed
      ? t("Original icon could not be decoded.")
      : transportFailed
        ? t("Could not load the original icon.")
        : result?.status === "missing"
          ? t(result.message)
          : result?.status === "unavailable"
            ? result.message
            : t("Loading original icon…");
  return (
    <div className="catalog-icon-wrap" ref={ref}>
      {result?.status === "ready" && !decodeFailed ? (
        <img
          className="catalog-icon"
          src={result.dataUrl}
          alt={t("{name} original icon", { name })}
          data-icon-sha256={result.sha256}
          data-icon-field={result.field}
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setDecodeFailed(true)}
        />
      ) : (
        <span
          className="catalog-icon catalog-icon-placeholder"
          role="img"
          aria-label={t("{name}: {message}", { name, message })}
          title={message}
        >
          <ImageOff aria-hidden="true" size={20} />
        </span>
      )}
      {failed && (
        <button
          className="catalog-icon-retry"
          aria-label={t("Retry icon for {name}", { name })}
          title={message}
          onClick={() => setRetry((n) => n + 1)}
        >
          {t("Retry icon")}
        </button>
      )}
    </div>
  );
}
