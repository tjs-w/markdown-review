import type { FileHandle } from "node:fs/promises";
import { open, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";

const READ_CHUNK_BYTES = 64 * 1024;

export interface FileSnapshot {
  readonly bytes: Buffer;
  readonly modifiedAt: string;
  readonly sizeBytes: number;
}

export interface BoundedReadOptions {
  readonly expectedCanonicalPath?: string;
}

function sameFileSnapshot(
  before: Awaited<ReturnType<FileHandle["stat"]>>,
  after: Awaited<ReturnType<FileHandle["stat"]>>,
  bytesRead: number,
): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    after.size === bytesRead &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

async function assertOpenedPath(
  filePath: string,
  expectedCanonicalPath: string | undefined,
  opened: Awaited<ReturnType<FileHandle["stat"]>>,
  label: string,
): Promise<void> {
  if (!expectedCanonicalPath) return;
  const canonicalPath = await realpath(filePath);
  const pathInfo = await stat(filePath);
  if (
    canonicalPath !== expectedCanonicalPath ||
    pathInfo.dev !== opened.dev ||
    pathInfo.ino !== opened.ino
  ) {
    throw new Error(`${label} path changed while it was being opened; retry the review.`);
  }
}

export async function readFileHandleBounded(
  filePath: string,
  maximumBytes: number,
  label: string,
  options: BoundedReadOptions = {},
): Promise<FileSnapshot> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`${label} must be a regular file.`);
    await assertOpenedPath(filePath, options.expectedCanonicalPath, before, label);
    if (before.size > maximumBytes)
      throw new Error(`${label} exceeds the ${maximumBytes}-byte limit.`);

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for (;;) {
      const remaining = maximumBytes + 1 - totalBytes;
      if (remaining <= 0) throw new Error(`${label} exceeds the ${maximumBytes}-byte limit.`);
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > maximumBytes)
        throw new Error(`${label} exceeds the ${maximumBytes}-byte limit.`);
      chunks.push(buffer.subarray(0, bytesRead));
    }

    const after = await handle.stat();
    if (!sameFileSnapshot(before, after, totalBytes)) {
      throw new Error(`${label} changed while it was being read; retry the review.`);
    }
    await assertOpenedPath(filePath, options.expectedCanonicalPath, after, label);

    return {
      bytes: Buffer.concat(chunks, totalBytes),
      modifiedAt: after.mtime.toISOString(),
      sizeBytes: totalBytes,
    };
  } finally {
    await handle.close();
  }
}
