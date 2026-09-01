import { describe, expect, mock, test } from "bun:test";

import { createMermaidRenderer, MAX_MERMAID_SOURCE_BYTES } from "./mermaid-renderer";

type MermaidEngine = NonNullable<Parameters<typeof createMermaidRenderer>[1]>;

function fakeEngine(svg: string): {
  readonly engine: MermaidEngine;
  readonly initialize: ReturnType<typeof mock>;
  readonly render: ReturnType<typeof mock>;
} {
  const initialize = mock(() => undefined);
  const render = mock(() => Promise.resolve({ svg }));
  return {
    engine: { initialize, render } as unknown as MermaidEngine,
    initialize,
    render,
  };
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "";
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("createMermaidRenderer", () => {
  test("uses strict bounded configuration and strips active or external SVG content", async () => {
    const bindFunctions = mock(() => undefined);
    const fixture =
      fakeEngine(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200" onload="alert(1)">
        <style>.safe{fill:red}.remote{fill:url(https://example.com/a.svg)}</style>
        <style>.remote2{fill:image-set("https://example.com/b.png" 1x)}</style>
        <script>alert(1)</script>
        <foreignObject><div xmlns="http://www.w3.org/1999/xhtml">unsafe</div></foreignObject>
        <defs><marker id="arrow"><path d="M0 0L10 5L0 10z" /></marker></defs>
        <a href="https://example.com"><text x="10" y="20">Linked label</text></a>
        <path class="safe" d="M0 0L10 10" marker-end="url(#arrow)" onclick="alert(1)" />
      </svg>`);
    fixture.render.mockImplementationOnce(() => {
      const temporary = document.createElement("div");
      temporary.id = "dflowzone-mermaid-1";
      document.body.appendChild(temporary);
      return Promise.resolve({
        svg: `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200" xml:base="https://example.com/" tabindex="0" onload="alert(1)">
          <style>body,.topbar{display:none!important}.safe{fill:red}</style>
          <style>.safe{fill:red}.remote{fill:url(https://example.com/a.svg)}</style>
          <style>.remote2{fill:image-set("https://example.com/b.png" 1x)}</style>
          <script>alert(1)</script>
          <foreignObject><div xmlns="http://www.w3.org/1999/xhtml">unsafe</div></foreignObject>
          <filter id="expensive"><feGaussianBlur stdDeviation="9999" /></filter>
          <defs><marker id="arrow"><path d="M0 0L10 5L0 10z" /></marker></defs>
          <a href="https://example.com"><text x="10" y="20" tabindex="1" role="link">Linked label</text></a>
          <use href="#missing" />
          <path class="safe" d="M0 0L10 10" filter="url(#expensive)" marker-end="url(#arrow)" onclick="alert(1)" />
        </svg>`,
        bindFunctions,
      });
    });
    const renderer = createMermaidRenderer(window, fixture.engine);

    const rendered = await renderer.render("flowchart LR\nA-->B", {
      id: "flowzone-mermaid-1",
      theme: "dark",
      accessibleLabel: "Mermaid diagram, lines 3–5",
    });
    const svg = rendered.element.shadowRoot?.querySelector("svg");
    if (!(svg instanceof SVGSVGElement)) throw new Error("Expected an isolated SVG diagram");

    expect(fixture.initialize).toHaveBeenCalledTimes(1);
    expect(fixture.initialize.mock.calls[0]?.[0]).toMatchObject({
      deterministicIds: true,
      flowchart: { htmlLabels: false },
      htmlLabels: false,
      maxEdges: 300,
      maxTextSize: MAX_MERMAID_SOURCE_BYTES,
      securityLevel: "strict",
      startOnLoad: false,
      suppressErrorRendering: true,
      theme: "dark",
    });
    expect(bindFunctions).not.toHaveBeenCalled();
    expect(rendered.byteLength).toBeGreaterThan(0);
    expect(rendered.elementCount).toBeGreaterThan(0);
    expect(rendered.element.className).toBe("mermaid-shadow-host");
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("Mermaid diagram, lines 3–5");
    expect(svg.hasAttribute("onload")).toBeFalse();
    expect(svg.hasAttribute("xml:base")).toBeFalse();
    expect(svg.hasAttribute("tabindex")).toBeFalse();
    expect(svg.querySelector("script, foreignObject")).toBeNull();
    expect(svg.querySelector("filter, use, [tabindex], [role]")).toBeNull();
    expect(svg.querySelectorAll("style")).toHaveLength(1);
    expect(svg.querySelector("style")?.textContent).toContain("body,.topbar");
    expect(document.querySelector(".mermaid-shadow-host style")).toBeNull();
    expect(svg.querySelector("a")).toBeNull();
    expect(svg.textContent).toContain("Linked label");
    expect(svg.querySelector("path[marker-end='url(#arrow)']")).not.toBeNull();
    expect(svg.querySelector("path[onclick]")).toBeNull();
    expect(document.getElementById("dflowzone-mermaid-1")).toBeNull();
  });

  test("rejects unbounded source, identifiers, dimensions, and element counts", async () => {
    const tooWide = fakeEngine(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100001 10"></svg>',
    );
    const renderer = createMermaidRenderer(window, tooWide.engine);

    expect(
      await rejectionMessage(
        renderer.render("flowchart LR\nA-->B", {
          id: "invalid id",
          theme: "light",
          accessibleLabel: "Diagram",
        }),
      ),
    ).toContain("identifier");
    expect(
      await rejectionMessage(
        renderer.render("x".repeat(MAX_MERMAID_SOURCE_BYTES + 1), {
          id: "flowzone-mermaid-large",
          theme: "light",
          accessibleLabel: "Diagram",
        }),
      ),
    ).toContain("32 KiB");
    expect(
      await rejectionMessage(
        renderer.render("flowchart LR\nA-->B", {
          id: "flowzone-mermaid-wide",
          theme: "light",
          accessibleLabel: "Diagram",
        }),
      ),
    ).toContain("dimensions");

    const elements = Array.from({ length: 10_001 }, () => "<g></g>").join("");
    const complex = fakeEngine(`<svg xmlns="http://www.w3.org/2000/svg">${elements}</svg>`);
    expect(
      await rejectionMessage(
        createMermaidRenderer(window, complex.engine).render("flowchart LR\nA-->B", {
          id: "flowzone-mermaid-complex",
          theme: "light",
          accessibleLabel: "Diagram",
        }),
      ),
    ).toContain("complex");
  });

  test("cancels stale queued jobs and isolates queues between renderer instances", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>';
    let resolveFirst: ((value: { svg: string }) => void) | undefined;
    let renderCalls = 0;
    const engine = {
      initialize: mock(() => undefined),
      render: mock(() => {
        renderCalls += 1;
        return renderCalls === 1
          ? new Promise<{ svg: string }>((resolve) => {
              resolveFirst = resolve;
            })
          : Promise.resolve({ svg });
      }),
    } as unknown as MermaidEngine;
    const renderer = createMermaidRenderer(window, engine);
    const activeAbort = new AbortController();
    const active = rejectionMessage(
      renderer.render("flowchart LR\nA-->B", {
        id: "flowzone-mermaid-active",
        theme: "light",
        accessibleLabel: "Active",
        signal: activeAbort.signal,
      }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(renderCalls).toBe(1);
    activeAbort.abort();
    expect(await active).toContain("cancelled");

    const isolated = fakeEngine(svg);
    const isolatedResult = await createMermaidRenderer(window, isolated.engine).render(
      "flowchart LR\nA-->B",
      {
        id: "flowzone-mermaid-isolated",
        theme: "light",
        accessibleLabel: "Isolated",
      },
    );
    expect(isolatedResult.element.shadowRoot?.querySelector("svg")).not.toBeNull();

    const queuedAbort = new AbortController();
    const queued = rejectionMessage(
      renderer.render("flowchart LR\nB-->C", {
        id: "flowzone-mermaid-queued",
        theme: "dark",
        accessibleLabel: "Queued",
        signal: queuedAbort.signal,
      }),
    );
    queuedAbort.abort();
    expect(await queued).toContain("cancelled");
    resolveFirst?.({ svg });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(renderCalls).toBe(1);

    const latest = await renderer.render("flowchart LR\nC-->D", {
      id: "flowzone-mermaid-latest",
      theme: "dark",
      accessibleLabel: "Latest",
    });
    expect(latest.element.shadowRoot?.querySelector("svg")).not.toBeNull();
    expect(renderCalls).toBe(2);
  });
});
