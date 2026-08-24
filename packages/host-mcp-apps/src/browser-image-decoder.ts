import {
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
  type ReviewImageMimeType,
} from "@markdown-review/contracts";
import type { ReviewImageDecoder } from "@markdown-review/review-ui";

const NATIVE_IMAGE_MIME_TYPES = new Set<ReviewImageMimeType>([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export function createBrowserImageDecoder(hostWindow: Window): ReviewImageDecoder {
  return {
    async decode(bytes, mimeType) {
      if (!NATIVE_IMAGE_MIME_TYPES.has(mimeType)) {
        throw new Error(`The image format ${mimeType} is not supported.`);
      }
      if (typeof hostWindow.createImageBitmap !== "function") {
        throw new Error("Native browser image decoding is unavailable.");
      }

      const blob = new Blob([Uint8Array.from(bytes).buffer], { type: mimeType });
      let bitmap: ImageBitmap;
      try {
        bitmap = await hostWindow.createImageBitmap(blob, { imageOrientation: "none" });
      } catch {
        throw new Error(`This browser could not decode ${mimeType}.`);
      }

      let canvas: HTMLCanvasElement | null = null;
      try {
        const { width, height } = bitmap;
        const pixels = width * height;
        if (
          !Number.isSafeInteger(width) ||
          !Number.isSafeInteger(height) ||
          width <= 0 ||
          height <= 0 ||
          width > MAX_IMAGE_DIMENSION ||
          height > MAX_IMAGE_DIMENSION ||
          !Number.isSafeInteger(pixels) ||
          pixels > MAX_IMAGE_PIXELS
        ) {
          throw new Error("The decoded image dimensions exceed the review limit.");
        }

        canvas = hostWindow.document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("Canvas image decoding is unavailable.");
        context.drawImage(bitmap, 0, 0);
        const image = context.getImageData(0, 0, width, height);
        if (image.data.length !== pixels * 4) {
          throw new Error("The decoded image pixel buffer is invalid.");
        }
        return { width, height, data: image.data };
      } finally {
        if (canvas) {
          canvas.width = 0;
          canvas.height = 0;
        }
        bitmap.close();
      }
    },
  };
}
