import type { Locale } from "../shared/locale";

interface NativeMessages {
  workspaceTitle: string;
  workspaceButton: string;
  importTitle: string;
  importButton: string;
  exportTitle: string;
  exportButton: string;
  presetFilter: string;
  presetTooLarge: string;
  unsavedTitle: string;
  unsavedMessage: string;
  unsavedDetail: string;
  // Electron response indices: 0 keeps editing (also default/cancel), 1 discards.
  unsavedButtons: [keepEditing: string, discardAndQuit: string];
  draftSaveTimeout: string;
  closeFailed: string;
}

export const nativeMessageCatalog: Record<Locale, NativeMessages> = {
  en: {
    workspaceTitle: "Choose a Synora workspace",
    workspaceButton: "Choose",
    importTitle: "Import bot preset",
    importButton: "Import",
    exportTitle: "Export bot preset",
    exportButton: "Export",
    presetFilter: "Synora bot preset",
    presetTooLarge: "Preset file exceeds 64 KiB",
    unsavedTitle: "Unsaved file changes",
    unsavedMessage: "Discard unsaved file changes and quit Synora?",
    unsavedDetail:
      "Conversation drafts are already saved. The edited file has not been overwritten.",
    unsavedButtons: ["Keep editing", "Discard and quit"],
    draftSaveTimeout:
      "The interface did not acknowledge saving its drafts. Close was cancelled.",
    closeFailed: "Close could not complete",
  },
  it: {
    workspaceTitle: "Scegli un'area di lavoro Synora",
    workspaceButton: "Scegli",
    importTitle: "Importa preimpostazione del bot",
    importButton: "Importa",
    exportTitle: "Esporta preimpostazione del bot",
    exportButton: "Esporta",
    presetFilter: "Preimpostazione del bot Synora",
    presetTooLarge: "Il file della preimpostazione supera 64 KiB",
    unsavedTitle: "Modifiche al file non salvate",
    unsavedMessage:
      "Scartare le modifiche al file non salvate e uscire da Synora?",
    unsavedDetail:
      "Le bozze delle conversazioni sono già salvate. Il file modificato non è stato sovrascritto.",
    unsavedButtons: ["Continua a modificare", "Scarta ed esci"],
    draftSaveTimeout:
      "L'interfaccia non ha confermato il salvataggio delle bozze. La chiusura è stata annullata.",
    closeFailed: "Impossibile completare la chiusura",
  },
  fr: {
    workspaceTitle: "Choisir un espace de travail Synora",
    workspaceButton: "Choisir",
    importTitle: "Importer un préréglage de bot",
    importButton: "Importer",
    exportTitle: "Exporter un préréglage de bot",
    exportButton: "Exporter",
    presetFilter: "Préréglage de bot Synora",
    presetTooLarge: "Le fichier de préréglage dépasse 64 KiB",
    unsavedTitle: "Modifications du fichier non enregistrées",
    unsavedMessage:
      "Abandonner les modifications du fichier non enregistrées et quitter Synora ?",
    unsavedDetail:
      "Les brouillons des conversations sont déjà enregistrés. Le fichier modifié n'a pas été écrasé.",
    unsavedButtons: ["Continuer à modifier", "Abandonner et quitter"],
    draftSaveTimeout:
      "L'interface n'a pas confirmé l'enregistrement des brouillons. La fermeture a été annulée.",
    closeFailed: "Impossible de terminer la fermeture",
  },
  de: {
    workspaceTitle: "Synora-Arbeitsbereich auswählen",
    workspaceButton: "Auswählen",
    importTitle: "Bot-Voreinstellung importieren",
    importButton: "Importieren",
    exportTitle: "Bot-Voreinstellung exportieren",
    exportButton: "Exportieren",
    presetFilter: "Synora-Bot-Voreinstellung",
    presetTooLarge: "Die Voreinstellungsdatei überschreitet 64 KiB",
    unsavedTitle: "Ungespeicherte Dateiänderungen",
    unsavedMessage:
      "Ungespeicherte Dateiänderungen verwerfen und Synora beenden?",
    unsavedDetail:
      "Die Gesprächsentwürfe sind bereits gespeichert. Die bearbeitete Datei wurde nicht überschrieben.",
    unsavedButtons: ["Weiter bearbeiten", "Verwerfen und beenden"],
    draftSaveTimeout:
      "Die Oberfläche hat das Speichern der Entwürfe nicht bestätigt. Das Schließen wurde abgebrochen.",
    closeFailed: "Das Schließen konnte nicht abgeschlossen werden",
  },
  es: {
    workspaceTitle: "Elegir un espacio de trabajo de Synora",
    workspaceButton: "Elegir",
    importTitle: "Importar preajuste de bot",
    importButton: "Importar",
    exportTitle: "Exportar preajuste de bot",
    exportButton: "Exportar",
    presetFilter: "Preajuste de bot de Synora",
    presetTooLarge: "El archivo de preajuste supera los 64 KiB",
    unsavedTitle: "Cambios del archivo sin guardar",
    unsavedMessage:
      "¿Descartar los cambios del archivo sin guardar y salir de Synora?",
    unsavedDetail:
      "Los borradores de las conversaciones ya están guardados. El archivo editado no se ha sobrescrito.",
    unsavedButtons: ["Seguir editando", "Descartar y salir"],
    draftSaveTimeout:
      "La interfaz no ha confirmado que se hayan guardado los borradores. Se ha cancelado el cierre.",
    closeFailed: "No se pudo completar el cierre",
  },
  // The shared persisted key is "pt"; these messages use Portuguese (Portugal).
  pt: {
    workspaceTitle: "Escolher uma área de trabalho do Synora",
    workspaceButton: "Escolher",
    importTitle: "Importar predefinição de bot",
    importButton: "Importar",
    exportTitle: "Exportar predefinição de bot",
    exportButton: "Exportar",
    presetFilter: "Predefinição de bot do Synora",
    presetTooLarge: "O ficheiro de predefinição excede 64 KiB",
    unsavedTitle: "Alterações ao ficheiro por guardar",
    unsavedMessage:
      "Descartar as alterações ao ficheiro por guardar e sair do Synora?",
    unsavedDetail:
      "Os rascunhos das conversas já estão guardados. O ficheiro editado não foi substituído.",
    unsavedButtons: ["Continuar a editar", "Descartar e sair"],
    draftSaveTimeout:
      "A interface não confirmou que os rascunhos foram guardados. O fecho foi cancelado.",
    closeFailed: "Não foi possível concluir o fecho",
  },
  nl: {
    workspaceTitle: "Een Synora-werkruimte kiezen",
    workspaceButton: "Kiezen",
    importTitle: "Botvoorinstelling importeren",
    importButton: "Importeren",
    exportTitle: "Botvoorinstelling exporteren",
    exportButton: "Exporteren",
    presetFilter: "Synora-botvoorinstelling",
    presetTooLarge: "Het voorinstellingsbestand is groter dan 64 KiB",
    unsavedTitle: "Niet-opgeslagen bestandswijzigingen",
    unsavedMessage:
      "Niet-opgeslagen bestandswijzigingen verwerpen en Synora afsluiten?",
    unsavedDetail:
      "De gespreksconcepten zijn al opgeslagen. Het bewerkte bestand is niet overschreven.",
    unsavedButtons: ["Verder bewerken", "Verwerpen en afsluiten"],
    draftSaveTimeout:
      "De interface heeft het opslaan van de concepten niet bevestigd. Het afsluiten is geannuleerd.",
    closeFailed: "Het afsluiten kon niet worden voltooid",
  },
};

/** Read on invocation, including after a preference change; startup/closed stores are safe. */
export function getNativeMessages(readLocale: () => unknown): NativeMessages {
  try {
    const locale = readLocale();
    if (
      typeof locale === "string" &&
      Object.hasOwn(nativeMessageCatalog, locale)
    )
      return nativeMessageCatalog[locale as Locale];
  } catch {
    // A missing/unavailable store must not prevent a native dialog or close notice.
  }
  return nativeMessageCatalog.en;
}
