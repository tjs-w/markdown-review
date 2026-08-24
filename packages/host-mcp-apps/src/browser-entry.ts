import { formatCodexSubmission } from "./format-codex-submission";
import { startMarkdownReviewRuntime } from "./browser-runtime";

startMarkdownReviewRuntime({
  submissionFormatter: formatCodexSubmission,
  allowNativeDevTools: document.documentElement.dataset["markdownReviewDeveloperMode"] === "true",
});
