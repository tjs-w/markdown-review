import mermaid, { type Mermaid, type MermaidConfig } from "mermaid";
import type {
  RenderedReviewDiagram,
  ReviewDiagramRenderer,
  ReviewTheme,
} from "@markdown-review/review-ui";

export const MAX_MERMAID_SOURCE_BYTES = 32 * 1024;
const MAX_MERMAID_SVG_BYTES = 1024 * 1024;
const MAX_MERMAID_SVG_ELEMENTS = 5_000;
const MAX_MERMAID_DIMENSION = 16_384;
const MAX_MERMAID_VIEWBOX_AREA = 64_000_000;
const MERMAID_RENDER_TIMEOUT_MS = 8_000;

const SAFE_SVG_ELEMENTS = new Set([
  "a",
  "circle",
  "clippath",
  "defs",
  "desc",
  "ellipse",
  "g",
  "line",
  "lineargradient",
  "marker",
  "mask",
  "path",
  "pattern",
  "polygon",
  "polyline",
  "radialgradient",
  "rect",
  "stop",
  "style",
  "svg",
  "switch",
  "symbol",
  "text",
  "textpath",
  "title",
  "tspan",
  "use",
]);

const LINK_ATTRIBUTES = new Set(["action", "data", "formaction", "href", "src", "xlink:href"]);
const INTERNAL_REFERENCE_ELEMENTS = new Set(["textpath", "use"]);
const SAFE_INTERNAL_REFERENCE = /^#[A-Za-z_][A-Za-z0-9_.:-]{0,255}$/;
const SAFE_ELEMENT_ID = /^[A-Za-z_][A-Za-z0-9_.:-]{0,255}$/;
const SAFE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const ROOT_ARIA_ATTRIBUTES = new Set(["aria-describedby", "aria-label", "aria-labelledby"]);
const FOCUS_ATTRIBUTES = new Set([
  "autofocus",
  "contenteditable",
  "draggable",
  "focusable",
  "tabindex",
]);

type MermaidEngine = Pick<Mermaid, "initialize" | "render">;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasUnsafeCss(css: string): boolean {
  if (
    /\\|@import|@font-face|expression\s*\(|javascript\s*:|data\s*:|behavior\s*:|-moz-binding/i.test(
      css,
    ) ||
    /https?\s*:|blob\s*:|file\s*:|\/\/|(?:-webkit-)?image-set\s*\(|cross-fade\s*\(|paint\s*\(/i.test(
      css,
    ) ||
    /:host|:host-context|::part|::slotted|@property|position\s*:\s*(?:fixed|sticky)/i.test(css)
  ) {
    return true;
  }
  const matches = css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi);
  let matchCount = 0;
  for (const match of matches) {
    matchCount += 1;
    if (!SAFE_INTERNAL_REFERENCE.test((match[2] ?? "").trim())) return true;
  }
  const urlTokens = css.match(/url\s*\(/gi)?.length ?? 0;
  return matchCount !== urlTokens;
}

function stripUnsupportedCss(css: string): string {
  return css.replace(/(^|[;{])\s*filter\s*:[^;}]*;?/gi, "$1");
}

function parseDimension(value: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/i.exec(value);
  if (!match) return value.trim() === "100%" ? null : Number.NaN;
  return Number(match[1]);
}

function dimensionsAreSafe(svg: Element): boolean {
  const viewBox = svg.getAttribute("viewBox");
  if (viewBox) {
    const values = viewBox
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (
      values.length !== 4 ||
      values.some((value) => !Number.isFinite(value)) ||
      Math.abs(values[0] ?? 0) > MAX_MERMAID_DIMENSION ||
      Math.abs(values[1] ?? 0) > MAX_MERMAID_DIMENSION ||
      (values[2] ?? 0) <= 0 ||
      (values[3] ?? 0) <= 0 ||
      (values[2] ?? 0) > MAX_MERMAID_DIMENSION ||
      (values[3] ?? 0) > MAX_MERMAID_DIMENSION ||
      (values[2] ?? 0) * (values[3] ?? 0) > MAX_MERMAID_VIEWBOX_AREA
    ) {
      return false;
    }
  }
  for (const name of ["width", "height"] as const) {
    const value = svg.getAttribute(name);
    if (!value) continue;
    const dimension = parseDimension(value);
    if (
      Number.isNaN(dimension) ||
      (dimension !== null && (dimension <= 0 || dimension > MAX_MERMAID_DIMENSION))
    ) {
      return false;
    }
  }
  return true;
}

function validateIdsAndReferences(svg: Element): void {
  const ids = new Set<string>();
  for (const element of [svg, ...svg.querySelectorAll("[id]")]) {
    const id = element.getAttribute("id");
    if (!id) continue;
    if (!SAFE_ELEMENT_ID.test(id)) {
      element.removeAttribute("id");
      continue;
    }
    if (ids.has(id)) throw new Error("Mermaid returned duplicate SVG identifiers.");
    ids.add(id);
  }
  for (const element of [svg, ...svg.querySelectorAll("*")]) {
    const localName = element.localName.toLowerCase();
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (
        INTERNAL_REFERENCE_ELEMENTS.has(localName) &&
        (name === "href" || name === "xlink:href")
      ) {
        const target = value.startsWith("#") ? value.slice(1) : "";
        if (!ids.has(target)) {
          if (localName === "use") element.remove();
          else element.replaceWith(...element.childNodes);
          break;
        }
      }
      if (!/url\s*\(/i.test(value)) continue;
      const references = [...value.matchAll(/url\(\s*(['"]?)#([^)'"\s]+)\1\s*\)/gi)];
      if (references.length === 0 || references.some((match) => !ids.has(match[2] ?? ""))) {
        element.removeAttribute(attribute.name);
      }
    }
    if (localName === "style" && /url\s*\(/i.test(element.textContent)) {
      const references = [...element.textContent.matchAll(/url\(\s*(['"]?)#([^)'"\s]+)\1\s*\)/gi)];
      if (references.length === 0 || references.some((match) => !ids.has(match[2] ?? ""))) {
        element.remove();
      }
    }
  }
  for (const name of ["aria-labelledby", "aria-describedby"] as const) {
    const value = svg.getAttribute(name);
    if (value?.split(/\s+/).some((id) => !ids.has(id)) === true) svg.removeAttribute(name);
  }
}

function sanitizeSvg(
  hostWindow: Window,
  source: string,
  accessibleLabel: string,
): { readonly svg: SVGSVGElement; readonly byteLength: number; readonly elementCount: number } {
  if (utf8Length(source) > MAX_MERMAID_SVG_BYTES) {
    throw new Error("The rendered Mermaid diagram exceeds the output limit.");
  }
  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  if (parsed.querySelector("parsererror")) {
    throw new Error("Mermaid returned invalid SVG.");
  }
  const svg = parsed.documentElement;
  if (svg.localName.toLowerCase() !== "svg" || svg.namespaceURI !== SVG_NAMESPACE) {
    throw new Error("Mermaid did not return an SVG diagram.");
  }
  const elements = [svg, ...svg.querySelectorAll("*")];
  if (elements.length > MAX_MERMAID_SVG_ELEMENTS) {
    throw new Error("The rendered Mermaid diagram is too complex.");
  }
  for (const element of elements) {
    const localName = element.localName.toLowerCase();
    if (element.namespaceURI !== SVG_NAMESPACE || !SAFE_SVG_ELEMENTS.has(localName)) {
      element.remove();
      continue;
    }
    if (localName === "style") {
      const css = stripUnsupportedCss(element.textContent);
      if (hasUnsafeCss(css)) {
        element.remove();
        continue;
      }
      element.textContent = css;
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (
        name.startsWith("on") ||
        name === "target" ||
        name === "xml:base" ||
        name === "filter" ||
        name === "role" ||
        FOCUS_ATTRIBUTES.has(name) ||
        (name.startsWith("aria-") && (element !== svg || !ROOT_ARIA_ATTRIBUTES.has(name))) ||
        (/^(?:javascript|data)\s*:/i.test(value) && name !== "aria-label")
      ) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (LINK_ATTRIBUTES.has(name)) {
        if (
          INTERNAL_REFERENCE_ELEMENTS.has(localName) &&
          (name === "href" || name === "xlink:href") &&
          SAFE_INTERNAL_REFERENCE.test(value)
        ) {
          continue;
        }
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === "style" && element === svg) {
        element.removeAttribute(attribute.name);
      } else if (name === "style") {
        const css = stripUnsupportedCss(value);
        if (hasUnsafeCss(css)) element.removeAttribute(attribute.name);
        else element.setAttribute(attribute.name, css);
      } else if (/url\s*\(/i.test(value) && hasUnsafeCss(value)) {
        element.removeAttribute(attribute.name);
      }
    }
    if (localName === "a") element.replaceWith(...element.childNodes);
  }
  validateIdsAndReferences(svg);
  if (!dimensionsAreSafe(svg)) {
    throw new Error("The rendered Mermaid diagram dimensions exceed the limit.");
  }
  const imported = hostWindow.document.importNode(svg, true);
  if (!(imported instanceof SVGSVGElement) || imported.localName.toLowerCase() !== "svg") {
    throw new Error("Mermaid returned an invalid diagram.");
  }
  const output = imported;
  output.setAttribute("role", "img");
  output.setAttribute("focusable", "false");
  if (!output.hasAttribute("aria-label") && !output.hasAttribute("aria-labelledby")) {
    output.setAttribute("aria-label", accessibleLabel.slice(0, 200));
  }
  const sanitizedSource = new XMLSerializer().serializeToString(output);
  const byteLength = utf8Length(sanitizedSource);
  const elementCount = 1 + output.querySelectorAll("*").length;
  if (byteLength > MAX_MERMAID_SVG_BYTES || elementCount > MAX_MERMAID_SVG_ELEMENTS) {
    throw new Error("The sanitized Mermaid diagram exceeds the output limit.");
  }
  return { svg: output, byteLength, elementCount };
}

function isolateSvg(
  hostWindow: Window,
  sanitized: ReturnType<typeof sanitizeSvg>,
): RenderedReviewDiagram {
  const element = hostWindow.document.createElement("span");
  element.className = "mermaid-shadow-host";
  const shadow = element.attachShadow({ mode: "open" });
  const style = hostWindow.document.createElement("style");
  style.textContent =
    ":host{display:block;width:100%;max-width:100%;overflow:auto}svg{display:block;width:auto;max-width:100%!important;height:auto;max-height:70vh;margin:auto}";
  shadow.append(style, sanitized.svg);
  return {
    element,
    byteLength: sanitized.byteLength,
    elementCount: sanitized.elementCount,
  };
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function observeRender<T>(
  hostWindow: Window,
  job: Promise<T>,
  signal: AbortSignal | undefined,
  cancel: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      hostWindow.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      operation();
    };
    const onAbort = (): void => {
      cancel();
      finish(() => {
        reject(abortError("The Mermaid render was cancelled."));
      });
    };
    const timer = hostWindow.setTimeout(() => {
      cancel();
      finish(() => {
        reject(new Error("The Mermaid render exceeded the time limit."));
      });
    }, MERMAID_RENDER_TIMEOUT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    job.then(
      (value) => {
        finish(() => {
          resolve(value);
        });
      },
      (error: unknown) => {
        finish(() => {
          reject(error instanceof Error ? error : new Error("The Mermaid render failed."));
        });
      },
    );
  });
}

function mermaidConfig(theme: ReviewTheme): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: "strict",
    theme: theme === "dark" ? "dark" : "default",
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    logLevel: "fatal",
    maxEdges: 300,
    maxTextSize: MAX_MERMAID_SOURCE_BYTES,
    deterministicIds: true,
    deterministicIDSeed: "flowzone",
    suppressErrorRendering: true,
    secure: [
      "deterministicIDSeed",
      "deterministicIds",
      "flowchart",
      "fontFamily",
      "htmlLabels",
      "maxEdges",
      "maxTextSize",
      "securityLevel",
      "secure",
      "suppressErrorRendering",
      "theme",
      "themeCSS",
      "themeVariables",
    ],
  };
}

export function createMermaidRenderer(
  hostWindow: Window,
  engine: MermaidEngine = mermaid,
): ReviewDiagramRenderer {
  let renderQueue: Promise<void> = Promise.resolve();
  return {
    render(source, request) {
      if (!SAFE_ID.test(request.id)) {
        return Promise.reject(new Error("The Mermaid render identifier is invalid."));
      }
      if (utf8Length(source) > MAX_MERMAID_SOURCE_BYTES) {
        return Promise.reject(new Error("The Mermaid source exceeds the 32 KiB limit."));
      }
      if (request.signal?.aborted) {
        return Promise.reject(abortError("The Mermaid render was cancelled."));
      }
      let cancelled = false;
      const run = renderQueue
        .catch(() => undefined)
        .then(async () => {
          if (cancelled || request.signal?.aborted) {
            throw abortError("The Mermaid render was cancelled.");
          }
          engine.initialize(mermaidConfig(request.theme));
          try {
            const result = await engine.render(request.id, source);
            return isolateSvg(
              hostWindow,
              sanitizeSvg(hostWindow, result.svg, request.accessibleLabel),
            );
          } finally {
            hostWindow.document.getElementById(`d${request.id}`)?.remove();
            hostWindow.document.getElementById(request.id)?.remove();
          }
        });
      renderQueue = run.then(
        () => undefined,
        () => undefined,
      );
      return observeRender(hostWindow, run, request.signal, () => {
        cancelled = true;
      });
    },
  };
}
