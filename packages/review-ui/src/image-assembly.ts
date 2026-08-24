export interface EncodedImageChunk {
  readonly chunkIndex: number;
  readonly chunkCount: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly data: string;
}

function decodeBase64(value: string): Uint8Array {
  const compact = value.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new Error("Image chunk data was altered in transit");
  }
  let binary: string;
  try {
    binary = atob(compact);
  } catch {
    throw new Error("Image chunk data was not valid base64");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function assembleImageChunks(
  chunks: readonly (EncodedImageChunk | undefined)[],
  expectedChunkCount: number,
  expectedByteLength: number,
): Uint8Array {
  if (chunks.length !== expectedChunkCount) throw new Error("The image payload is incomplete");
  const output = new Uint8Array(expectedByteLength);
  let expectedOffset = 0;
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex];
    if (
      chunk?.chunkIndex !== chunkIndex ||
      chunk.chunkCount !== expectedChunkCount ||
      chunk.byteOffset !== expectedOffset
    ) {
      throw new Error("The image payload is incomplete");
    }
    const bytes = decodeBase64(chunk.data);
    if (bytes.length !== chunk.byteLength || expectedOffset + bytes.length > expectedByteLength) {
      throw new Error(`Image chunk ${chunkIndex + 1} has an invalid length`);
    }
    output.set(bytes, expectedOffset);
    expectedOffset += bytes.length;
  }
  if (expectedOffset !== expectedByteLength) throw new Error("The image payload is incomplete");
  return output;
}
