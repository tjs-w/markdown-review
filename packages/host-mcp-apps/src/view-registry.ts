import type { FlowZoneUiEnvelopeBase } from "@flowzone/contracts";
import type { z } from "zod";

export interface FlowZoneViewRegistration<T = unknown> {
  readonly plugin: string;
  readonly action: string;
  readonly view: string;
  readonly payloadSchema: z.ZodType<T>;
  readonly render: (payload: T) => void | Promise<void>;
}

export interface FlowZoneViewRegistry {
  dispatch(envelope: FlowZoneUiEnvelopeBase): Promise<boolean>;
}

export type FlowZoneFallbackView = (envelope: FlowZoneUiEnvelopeBase) => boolean | Promise<boolean>;

function routeKey(plugin: string, action: string, view: string): string {
  return `${plugin}\u0000${action}\u0000${view}`;
}

export function createFlowZoneViewRegistry(
  registrations: readonly FlowZoneViewRegistration[],
  fallback?: FlowZoneFallbackView,
): FlowZoneViewRegistry {
  const routes = new Map<string, FlowZoneViewRegistration>();
  for (const registration of registrations) {
    const key = routeKey(registration.plugin, registration.action, registration.view);
    if (routes.has(key)) throw new Error("A FlowZone UI view route was registered more than once.");
    routes.set(key, registration);
  }
  return {
    async dispatch(envelope): Promise<boolean> {
      const registration = routes.get(routeKey(envelope.plugin, envelope.action, envelope.view));
      if (!registration) return (await fallback?.(envelope)) ?? false;
      const parsed = registration.payloadSchema.safeParse(envelope.payload);
      if (!parsed.success) throw new Error("The FlowZone UI view payload is invalid.");
      await registration.render(parsed.data);
      return true;
    },
  };
}
