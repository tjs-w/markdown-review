import { describe, expect, test } from "bun:test";

import {
  FlowZonePrivateErrorSchema,
  FlowZoneGenericViewPayloadSchema,
  FlowZoneRequestBaseSchema,
  FlowZoneResultBaseSchema,
  FlowZoneUiEnvelopeBaseSchema,
} from "./index";

describe("FlowZone wire contracts", () => {
  test("keeps router request and result envelopes strict", () => {
    expect(
      FlowZoneRequestBaseSchema.parse({
        plugin: "markdown-review",
        action: "open",
        input: { path: "/tmp/review.md" },
      }),
    ).toEqual({
      plugin: "markdown-review",
      action: "open",
      input: { path: "/tmp/review.md" },
    });
    expect(() =>
      FlowZoneResultBaseSchema.parse({
        schema: "flowzone/result-v1",
        plugin: "markdown-review",
        action: "open",
        result: {},
        extra: true,
      }),
    ).toThrow();
  });

  test("separates private UI and stable error metadata", () => {
    expect(
      FlowZoneGenericViewPayloadSchema.parse({ title: "Completed", message: "Done." }),
    ).toEqual({ title: "Completed", message: "Done." });
    expect(
      FlowZoneUiEnvelopeBaseSchema.parse({
        schema: "flowzone/ui-v1",
        plugin: "markdown-review",
        action: "open",
        view: "review",
        payload: { private: true },
      }),
    ).toMatchObject({ view: "review", payload: { private: true } });
    expect(
      FlowZonePrivateErrorSchema.parse({
        schema: "flowzone/error-v1",
        plugin: "markdown-review",
        action: "open",
        code: "timeout",
        retryable: true,
      }),
    ).toMatchObject({ code: "timeout", retryable: true });
  });
});
