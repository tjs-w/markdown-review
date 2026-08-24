import { realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

export interface MarkdownPathPolicy {
  resolveMarkdownPath(pathInput: string): Promise<string>;
  resolveLocalImagePath(markdownPath: string, source: string): Promise<string>;
}

function isWithinDirectory(directory: string, candidate: string): boolean {
  const fromDirectory = relative(directory, candidate);
  return (
    fromDirectory !== "" &&
    fromDirectory !== ".." &&
    !fromDirectory.startsWith(`..${sep}`) &&
    !isAbsolute(fromDirectory)
  );
}

export class DefaultMarkdownPathPolicy implements MarkdownPathPolicy {
  async resolveMarkdownPath(pathInput: string): Promise<string> {
    if (!isAbsolute(pathInput)) throw new Error("Pass an absolute Markdown file path.");
    const requestedPath = resolve(pathInput);
    if (![".md", ".markdown"].includes(extname(requestedPath).toLowerCase())) {
      throw new Error("Markdown Review only opens .md and .markdown files.");
    }
    const canonicalPath = await realpath(requestedPath);
    if (![".md", ".markdown"].includes(extname(canonicalPath).toLowerCase())) {
      throw new Error("The resolved file must also be a .md or .markdown file.");
    }
    return canonicalPath;
  }

  async resolveLocalImagePath(markdownPath: string, source: string): Promise<string> {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(source) || isAbsolute(source)) {
      throw new Error("only relative local PNG paths are supported");
    }

    const pathWithoutSuffix = source.split(/[?#]/, 1)[0] ?? "";
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(pathWithoutSuffix);
    } catch {
      throw new Error("the path is invalid");
    }
    if (!decodedPath || decodedPath.includes("\0") || isAbsolute(decodedPath)) {
      throw new Error("the path is invalid");
    }

    const documentDirectory = await realpath(dirname(markdownPath));
    const candidate = await realpath(resolve(documentDirectory, decodedPath));
    if (!isWithinDirectory(documentDirectory, candidate)) {
      throw new Error("the path is outside the Markdown folder");
    }
    if (extname(candidate).toLowerCase() !== ".png") {
      throw new Error("use a PNG file for local review images");
    }
    return candidate;
  }
}
