import { readFile } from "node:fs/promises";

export interface ReviewUiAssets {
  readonly template: string;
  readonly reviewBundle: string;
}

export interface ReviewUiAssetLoader {
  load(): Promise<ReviewUiAssets>;
}

export interface FileReviewUiAssetLoaderOptions {
  readonly templatePath: string;
  readonly reviewBundlePath: string;
}

export interface FlowZoneUiAssets {
  readonly template: string;
  readonly bundle: string;
}

export interface FlowZoneUiAssetLoader {
  load(): Promise<FlowZoneUiAssets>;
}

export interface FileFlowZoneUiAssetLoaderOptions {
  readonly templatePath: string;
  readonly bundlePath: string;
}

export function createFileFlowZoneUiAssetLoader(
  options: FileFlowZoneUiAssetLoaderOptions,
): FlowZoneUiAssetLoader {
  return {
    async load(): Promise<FlowZoneUiAssets> {
      const [template, bundle] = await Promise.all([
        readFile(options.templatePath, "utf8"),
        readFile(options.bundlePath, "utf8"),
      ]);
      return { template, bundle };
    },
  };
}

export function adaptReviewUiAssetLoader(loader: ReviewUiAssetLoader): FlowZoneUiAssetLoader {
  return {
    async load(): Promise<FlowZoneUiAssets> {
      const assets = await loader.load();
      return { template: assets.template, bundle: assets.reviewBundle };
    },
  };
}

export function createFileReviewUiAssetLoader(
  options: FileReviewUiAssetLoaderOptions,
): ReviewUiAssetLoader {
  return {
    async load(): Promise<ReviewUiAssets> {
      const [template, reviewBundle] = await Promise.all([
        readFile(options.templatePath, "utf8"),
        readFile(options.reviewBundlePath, "utf8"),
      ]);
      return { template, reviewBundle };
    },
  };
}
