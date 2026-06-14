import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

export interface ImageInput {
  mediaType: 'image/png' | 'image/jpeg';
  base64: string;
}

// Cap to bound prompt token cost; both input paths enforce it.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const EXT_MEDIA: Record<string, ImageInput['mediaType']> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

function validate(mediaType: ImageInput['mediaType'] | null, bytes: Buffer, what: string): ImageInput {
  if (!mediaType) throw new Error(`${what}: content-type must be image/png or image/jpeg`);
  if (bytes.length === 0) throw new Error(`${what}: image is empty`);
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`${what}: image too large (${(bytes.length / 1024 / 1024).toFixed(1)} MB, max 5 MB)`);
  }
  return { mediaType, base64: bytes.toString('base64') };
}

// CLI --image path: media type comes from the file extension.
export function loadImageFromFile(path: string): ImageInput {
  const mediaType = EXT_MEDIA[extname(path).toLowerCase()] ?? null;
  if (!mediaType) throw new Error(`unsupported image type "${extname(path) || path}" — use .png, .jpg, or .jpeg`);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new Error(`cannot read image: ${path}`);
  }
  return validate(mediaType, bytes, path);
}

// Dock upload path: media type comes from the request Content-Type header.
export function imageFromBytes(contentType: string | undefined, bytes: Buffer): ImageInput {
  const mediaType =
    contentType === 'image/png' || contentType === 'image/jpeg' ? contentType : null;
  return validate(mediaType, bytes, 'upload');
}
