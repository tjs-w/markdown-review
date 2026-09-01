import type {
  PersistedReviewState,
  PrivateReviewImageChunk,
  ReviewDocument,
  ReviewImageChunkRequest,
  ReviewImageMimeType,
  ReviewSubmission,
} from "@markdown-review/contracts";

export type DisplayMode = "inline" | "fullscreen" | "pip";
export type ReviewTheme = "light" | "dark";

export type ReviewPortErrorCode =
  | "server_error"
  | "private_metadata_missing"
  | "private_metadata_invalid"
  | "summary_mismatch"
  | "host_contract_mismatch";

export type ReviewServerErrorCode =
  | "session_expired"
  | "stale_revision"
  | "image_not_found"
  | "chunk_out_of_range"
  | "image_load_failed";

export class ReviewPortError extends Error {
  readonly code: ReviewPortErrorCode;
  readonly retryable: boolean;
  readonly serverCode: ReviewServerErrorCode | undefined;

  constructor(
    code: ReviewPortErrorCode,
    message: string,
    retryable = false,
    serverCode?: ReviewServerErrorCode,
  ) {
    super(message);
    this.name = "ReviewPortError";
    this.code = code;
    this.retryable = retryable;
    this.serverCode = serverCode;
  }
}

export function shouldRetryPortError(error: unknown): boolean {
  return !(error instanceof ReviewPortError) || error.retryable;
}

export interface DocumentRef {
  readonly reviewSessionId: string;
  readonly path: string;
  readonly revision: string;
}

export interface HostCapabilities {
  readonly documentTools?: boolean;
  readonly displayMode?: boolean;
  readonly externalLinks?: boolean;
  readonly intrinsicHeight?: boolean;
  readonly submission?: boolean;
  readonly reviewSubmission?: boolean;
}

export interface HostContext {
  readonly displayMode: DisplayMode;
  readonly theme: ReviewTheme;
  readonly availableDisplayModes?: readonly DisplayMode[];
  readonly containerDimensions?: {
    readonly width?: number | undefined;
    readonly maxWidth?: number | undefined;
    readonly height?: number | undefined;
    readonly maxHeight?: number | undefined;
  };
  readonly locale?: string;
}

export type HostContextListener = (context: HostContext) => void;

export interface DocumentPort {
  refresh(reviewSessionId: string): Promise<ReviewDocument>;
  checkForUpdate?(document: DocumentRef): Promise<boolean>;
  recover?(document: DocumentRef): Promise<ReviewDocument>;
  loadAssetChunk(request: ReviewImageChunkRequest): Promise<PrivateReviewImageChunk>;
}

export interface SubmissionPort {
  submit(request: ReviewSubmission): Promise<void>;
  review?(request: ReviewSubmission): Promise<void>;
}

export interface PresentationPort {
  readonly capabilities: HostCapabilities;
  getContext(): HostContext;
  subscribe(listener: HostContextListener): () => void;
  requestDisplayMode?(mode: DisplayMode): Promise<DisplayMode>;
  openExternal?(url: URL): Promise<void>;
  notifyIntrinsicHeight?(height: number): void;
}

export interface ReviewStateStore {
  load(document: DocumentRef): Promise<PersistedReviewState | null>;
  save(snapshot: PersistedReviewState): Promise<void>;
}

export interface ClipboardPort {
  writeText(text: string): Promise<void>;
}

export interface MarkdownReviewPorts {
  readonly documents: DocumentPort;
  readonly submissions: SubmissionPort;
  readonly presentation: PresentationPort;
  readonly state: ReviewStateStore;
  readonly clipboard?: ClipboardPort;
}

export interface DecodedReviewImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

export interface ReviewImageDecodeRequest {
  readonly expectedWidth: number;
  readonly expectedHeight: number;
  readonly outputWidth: number;
  readonly outputHeight: number;
}

export interface ReviewImageDecoder {
  decode(
    bytes: Uint8Array,
    mimeType: ReviewImageMimeType,
    request?: ReviewImageDecodeRequest,
  ): Promise<DecodedReviewImage>;
}

export interface ReviewDiagramRenderRequest {
  readonly id: string;
  readonly theme: ReviewTheme;
  readonly accessibleLabel: string;
  readonly signal?: AbortSignal;
}

export interface RenderedReviewDiagram {
  readonly element: HTMLElement;
  readonly byteLength: number;
  readonly elementCount: number;
}

export interface ReviewDiagramRenderer {
  render(source: string, request: ReviewDiagramRenderRequest): Promise<RenderedReviewDiagram>;
}

export interface MountMarkdownReviewOptions {
  readonly root?: Document;
  readonly ports: MarkdownReviewPorts;
  readonly initialDocument?: ReviewDocument;
  readonly imageDecoder?: ReviewImageDecoder;
  readonly diagramRenderer?: ReviewDiagramRenderer;
  readonly allowNativeDevTools?: boolean;
}

export interface MarkdownReviewHandle {
  openDocument(document: ReviewDocument): Promise<void>;
  showError(error: unknown, retry?: () => void): void;
  flush(): Promise<void>;
  destroy(): void;
}
