import { createRoot } from "react-dom/client";
import { App } from "./App";
import { platformAPI } from "./platform";
import { useI18n, type Messages } from "./i18n";
import "./style.css";
const bootMessages: Messages = {
  "Synora could not start": ["Impossibile avviare Synora", "Impossible de démarrer Synora", "Synora konnte nicht gestartet werden", "No se pudo iniciar Synora", "Não foi possível iniciar o Synora", "Synora kon niet starten"],
  "Platform adapter unavailable": ["Adattatore della piattaforma non disponibile", "Adaptateur de plateforme indisponible", "Plattformadapter nicht verfügbar", "Adaptador de plataforma no disponible", "Adaptador da plataforma indisponível", "Platformadapter niet beschikbaar"],
};
function BootFailure({ error }: { error: unknown }) {
  const { t } = useI18n(bootMessages);
  return <main className="boot"><h1>{t("Synora could not start")}</h1>
    <p>{error instanceof Error ? error.message : t("Platform adapter unavailable")}</p></main>;
}
const root = createRoot(document.getElementById("root")!);
try {
  root.render(<App api={platformAPI()} />);
} catch (error) {
  root.render(<BootFailure error={error} />);
}
