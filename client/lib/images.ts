// client/lib/images.ts
//
// Browser half of chat-image attachments: File/Blob → ChatImage plus the
// paste/pick handler both composers (Hub create form, Conversation follow-up)
// share. The accept rules live in ../../images.ts so client pre-checks and
// the server's authoritative gate enforce the exact same caps.

import { selectChatImages, type ChatImage, type ChatImageMediaType } from "../../server/openhands/images.js";

export type { ChatImage };

/** File/Blob → ChatImage (strips the data: URL prefix FileReader adds). */
export function fileToChatImage(file: File): Promise<ChatImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("could not read the image"));
    reader.onload = () => {
      const url = String(reader.result);
      const comma = url.indexOf(",");
      resolve({ mediaType: file.type as ChatImageMediaType, data: url.slice(comma + 1) });
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Handle one paste/pick batch: filters candidates against the caps, converts
 * the accepted ones, and returns the images plus the first reject reason (if
 * any) for an inline hint.
 */
export async function collectChatImages(
  files: File[],
  currentCount: number,
): Promise<{ images: ChatImage[]; reason: string | null }> {
  const { accepted, reason } = selectChatImages(
    files.map((f) => ({ type: f.type, size: f.size })),
    currentCount,
  );
  const images = await Promise.all(accepted.map((i) => fileToChatImage(files[i]!)));
  return { images, reason };
}
