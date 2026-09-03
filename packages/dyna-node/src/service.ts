import {
  DynaDashboardSnapshotSchema,
  DynaUiPayloadSchema,
  dynaCatalog,
  type DynaPublishedItem,
  type DynaTaskStatus,
  type DynaUiPayload,
} from "@flowzone/dyna-contracts";
import { compileDashboard } from "@flowzone/dyna-core";

import {
  DynaStore,
  type DynaPublishOptions,
  type DynaPublishResult,
  type DynaStoreOptions,
} from "./store.js";

export class DynaService {
  readonly store: DynaStore;

  constructor(options: DynaStoreOptions = {}) {
    this.store = new DynaStore(options);
  }

  close(): void {
    this.store.close();
  }

  render(dashboardId: string): DynaUiPayload {
    const snapshot = this.store.snapshot(dashboardId);
    const payload = {
      schema: "dyna/ui-v1" as const,
      viewToken: this.store.createView(dashboardId),
      snapshot,
      spec: compileDashboard(snapshot),
    };
    return DynaUiPayloadSchema.parse(payload);
  }

  refresh(viewToken: string): DynaUiPayload {
    const snapshot = this.store.snapshotForView(viewToken);
    const validated = dynaCatalog.validate(compileDashboard(snapshot));
    if (!validated.success || !validated.data)
      throw new Error("Dyna could not compile its dashboard.");
    return DynaUiPayloadSchema.parse({
      schema: "dyna/ui-v1",
      viewToken,
      snapshot,
      spec: validated.data,
    });
  }

  publish(
    publisherId: string,
    secret: string,
    items: readonly DynaPublishedItem[],
    options: DynaPublishOptions,
  ): DynaPublishResult {
    return this.store.publish(publisherId, secret, items, options);
  }

  snapshot(dashboardId: string) {
    return DynaDashboardSnapshotSchema.parse(this.store.snapshot(dashboardId));
  }

  updateTask(itemId: string, status: DynaTaskStatus): void {
    this.store.upsertTaskStatus(itemId, status);
  }
}
