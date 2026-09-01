import { formatCodexSubmission } from "./format-codex-submission";
import { startFlowZoneRuntime } from "./browser-runtime";

startFlowZoneRuntime({
  submissionFormatter: formatCodexSubmission,
  allowNativeDevTools: document.documentElement.dataset["flowzoneDeveloperMode"] === "true",
});
