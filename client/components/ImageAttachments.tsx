// client/components/ImageAttachments.tsx
//
// Shared chat-image attachment UI for the Hub create form and the
// Conversation follow-up composer: paste/pick state management (useChatImages)
// plus the preview chips and the attach button. Caps mirror the server's
// (../../images.ts) so rejects are instant and never a 400 round trip.

import { useCallback, useEffect, useRef, useState, type ClipboardEvent } from "react";
import { CHAT_IMAGE_MAX_COUNT, CHAT_IMAGE_MEDIA_TYPES, toImageDataUrl } from "../../server/openhands/images.js";
import { collectChatImages, type ChatImage } from "../lib/images.js";

export interface ChatImagesState {
  images: ChatImage[];
  /** First reject reason of the latest paste/pick batch — inline hint text. */
  hint: string | null;
  /** Clipboard handler for the composer textarea (ignores text-only pastes). */
  onPaste: (e: ClipboardEvent) => void;
  addFiles: (files: File[]) => void;
  remove: (index: number) => void;
  clear: () => void;
}

export function useChatImages(): ChatImagesState {
  const [images, setImages] = useState<ChatImage[]>([]);
  const [hint, setHint] = useState<string | null>(null);
  // Mirror of images.length so addFiles can stay dependency-free. Kicking the
  // async read off inside a setImages updater is NOT an option: updaters must
  // be pure — React StrictMode double-invokes them in dev, which duplicated
  // every attachment.
  const countRef = useRef(0);
  useEffect(() => {
    countRef.current = images.length;
  }, [images]);

  const addFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    void collectChatImages(files, countRef.current).then(({ images: added, reason }) => {
      setHint(reason);
      if (added.length > 0) setImages((latest) => [...latest, ...added].slice(0, CHAT_IMAGE_MAX_COUNT));
    });
  }, []);

  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (files.length === 0) return; // plain text paste — leave it to the textarea
      e.preventDefault();
      addFiles(files);
    },
    [addFiles],
  );

  const remove = useCallback((index: number) => {
    setImages((current) => current.filter((_, i) => i !== index));
    setHint(null);
  }, []);

  const clear = useCallback(() => {
    setImages([]);
    setHint(null);
  }, []);

  return { images, hint, onPaste, addFiles, remove, clear };
}

/** Thumbnail previews of staged attachments, each with a remove button. */
export function ImageChips({ state }: { state: ChatImagesState }) {
  if (state.images.length === 0 && !state.hint) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 px-2 pb-1" data-testid="openhands-image-chips">
      {state.images.map((img, i) => (
        <span key={i} className="relative inline-flex">
          <img
            src={toImageDataUrl(img)}
            alt={`attachment ${i + 1}`}
            className="h-12 w-12 rounded-md border border-[var(--color-border-default)] object-cover"
          />
          <button
            type="button"
            onClick={() => state.remove(i)}
            title="Remove image"
            aria-label={`Remove image ${i + 1}`}
            className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border border-[var(--color-border-default)] bg-[var(--color-background-base)] text-[10px] leading-none text-[var(--color-text-muted)] hover:text-[var(--color-text-default)] pointer-coarse:h-6 pointer-coarse:w-6 pointer-coarse:text-xs"
          >
            ×
          </button>
        </span>
      ))}
      {state.hint && <span className="text-[11px] text-[var(--color-text-muted)]">{state.hint}</span>}
    </div>
  );
}

/** Paperclip button wrapping a hidden file input (multiple, image types only). */
export function AttachImagesButton({ state, disabled }: { state: ChatImagesState; disabled?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const full = state.images.length >= CHAT_IMAGE_MAX_COUNT;
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={CHAT_IMAGE_MEDIA_TYPES.join(",")}
        multiple
        className="hidden"
        data-testid="openhands-image-input"
        onChange={(e) => {
          state.addFiles(Array.from(e.target.files ?? []));
          e.target.value = ""; // allow re-picking the same file
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled || full}
        title={full ? `At most ${CHAT_IMAGE_MAX_COUNT} images per message` : "Attach images (or paste from the clipboard)"}
        aria-label="Attach images"
        data-testid="openhands-attach-images"
        className="rounded border border-[var(--color-border-default)] px-2 py-1 text-[11px] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-default)] disabled:opacity-50 pointer-coarse:min-h-10 pointer-coarse:px-3"
      >
        📎{state.images.length > 0 ? ` ${state.images.length}` : ""}
      </button>
    </>
  );
}
