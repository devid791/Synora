import { useEffect, useRef, useState, type RefObject } from "react";
import type { AppState, DesktopAPI } from "../shared/contracts";
import { useI18n } from "./i18n";
import { messages } from "./locales/composer";
import {
  MAX_IMAGE_BYTES,
  imageMimes,
  type ImageAttachment,
} from "../shared/image-attachments";

export function AttachedImage({
  api,
  conversationId,
  image,
  remove,
  disabled,
}: {
  api: DesktopAPI;
  conversationId: string;
  image: ImageAttachment;
  remove?: () => void;
  disabled?: boolean;
}) {
  const { t, number } = useI18n(messages);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [decodeError, setDecodeError] = useState(false);
  useEffect(() => {
    let active = true;
    setUrl("");
    setError("");
    setDecodeError(false);
    void api
      .imageRead(conversationId, image.id)
      .then((result) => {
        if (!active) return;
        if (result.ok) setUrl(result.value.dataUrl);
        else setError(result.error.message);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [api, conversationId, image.id]);
  return (
    <figure className="image-attachment" data-image-id={image.id}>
      {url && !error && !decodeError ? (
        <img
          src={url}
          alt={image.name}
          onError={() => setDecodeError(true)}
        />
      ) : (
        <span role={error || decodeError ? "alert" : "status"}>
          {error || t(decodeError ? "Image cannot be decoded" : "Loading image…")}
        </span>
      )}
      <figcaption>
        {image.name} · {number(Math.round(image.bytes / 1024))} KiB
      </figcaption>
      {remove && (
        <button
          type="button"
          disabled={disabled}
          aria-label={t("Remove image {name}", { name: image.name })}
          onClick={remove}
        >
          {t("Remove")}
        </button>
      )}
    </figure>
  );
}

/** Read event-owned files synchronously. Never read arbitrary clipboard paths,
 * fetch an HTML image URL, or treat rich clipboard markup as executable HTML. */
export function transferredFiles(data: DataTransfer): File[] {
  const files = Array.from(data.files);
  return files.length ? files : Array.from(data.items)
    .filter(item => item.kind === "file")
    .map(item => item.getAsFile()).filter((file): file is File => !!file);
}

/** One App-owned admission gate for the picker, paste and drop. It survives
 * closing the + menu and navigation, and participates in the close handshake. */
export function useImageUpload({
  api,
  ensureConversation,
  updated,
  busy,
  setBusy,
  failed,
  pending,
}: {
  api: DesktopAPI;
  ensureConversation: () => Promise<string>;
  updated: (state: AppState) => void;
  busy: boolean;
  setBusy: (value: boolean) => void;
  failed: (error: unknown) => void;
  pending: RefObject<Promise<void> | null>;
}) {
  const { t, number } = useI18n(messages);
  return (files: File[]) => {
    if (!files.length) return Promise.resolve();
    if (pending.current || busy) {
      failed(Error(t("Wait until the current operation finishes before attaching images.")));
      return Promise.resolve();
    }
    setBusy(true);
    const write = Promise.resolve().then(async () => {
      // Reject the whole selection before creating a conversation or persisting
      // any image if its format/size is unsupported. Content is validated too.
      for (const file of files) {
        if (
          !imageMimes.includes(file.type as (typeof imageMimes)[number]) ||
          !file.size ||
          file.size > MAX_IMAGE_BYTES
        )
          throw Error(
            t("Attach PNG, JPEG or WebP files up to {size} MiB each. Original bytes are preserved.", { size: number(MAX_IMAGE_BYTES / 1024 ** 2) }),
          );
      }
      const id = await ensureConversation();
      for (const file of files) {
        // Decode before persisting; no upload of a disguised HTML/SVG document.
        const decoded = await createImageBitmap(file).catch(() => { throw Error(t("Image cannot be decoded")); });
        decoded.close();
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () =>
            reject(Error(t("Could not read the selected image")));
          reader.readAsDataURL(file);
        });
        const result = await api.imageAttach(id, { name: file.name || `pasted-image.${file.type === "image/jpeg" ? "jpg" : file.type.split("/")[1]}`, dataUrl });
        if (!result.ok) throw Error(result.error.message);
        updated(result.value);
      }
    }).catch(failed).finally(() => {
      if (pending.current === write) pending.current = null;
      setBusy(false);
    });
    pending.current = write;
    return write;
  };
}

export function ImageInput({ busy, upload }: {
  busy: boolean;
  upload: (files: File[]) => Promise<void>;
}) {
  const { t, number } = useI18n(messages);
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        aria-label={t("Attach image files")}
        hidden
        multiple
        accept={imageMimes.join(",")}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          void upload(files);
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => input.current?.click()}
        title={t("PNG, JPEG or WebP, up to {size} MiB per original image", { size: number(MAX_IMAGE_BYTES / 1024 ** 2) })}
      >
        {t("Attach images")}
      </button>
    </>
  );
}
