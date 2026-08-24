import type {
  PersistedReviewState,
  PrivateReviewImageChunk,
  ReviewDocument,
  ReviewImageChunkRequest,
  ReviewSubmission,
} from "@markdown-review/contracts";

export type DisplayMode = "inline" | "fullscreen" | "pip";
export type ReviewTheme = "light" | "dark";

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
  loadAssetChunk(request: ReviewImageChunkRequest): Promise<PrivateReviewImageChunk>;
}

export interface SubmissionPort {
  submit(request: ReviewSubmission): Promise<void>;
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

export interface MarkdownReviewPorts {
  readonly documents: DocumentPort;
  readonly submissions: SubmissionPort;
  readonly presentation: PresentationPort;
  readonly state: ReviewStateStore;
}

export interface DecodedReviewImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

export interface ReviewImageDecoder {
  decodePng(bytes: Uint8Array): DecodedReviewImage;
}

export interface MountMarkdownReviewOptions {
  readonly root?: Document;
  readonly ports: MarkdownReviewPorts;
  readonly initialDocument?: ReviewDocument;
  readonly imageDecoder?: ReviewImageDecoder;
}

export interface MarkdownReviewHandle {
  openDocument(document: ReviewDocument): Promise<void>;
  showError(error: unknown, retry?: () => void): void;
  destroy(): void;
}
