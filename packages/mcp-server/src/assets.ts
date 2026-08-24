import { readFile } from "node:fs/promises";

export interface ReviewUiAssets {
  readonly template: string;
  readonly pngDecoder: string;
  readonly reviewBundle: string;
}

export interface ReviewUiAssetLoader {
  load(): Promise<ReviewUiAssets>;
}

export interface FileReviewUiAssetLoaderOptions {
  readonly templatePath: string;
  readonly pngDecoderPath: string;
  readonly reviewBundlePath: string;
}

export function createFileReviewUiAssetLoader(
  options: FileReviewUiAssetLoaderOptions,
): ReviewUiAssetLoader {
  return {
    async load(): Promise<ReviewUiAssets> {
      const [template, pngDecoder, reviewBundle] = await Promise.all([
        readFile(options.templatePath, "utf8"),
        readFile(options.pngDecoderPath, "utf8"),
        readFile(options.reviewBundlePath, "utf8"),
      ]);
      return { template, pngDecoder, reviewBundle };
    },
  };
}
