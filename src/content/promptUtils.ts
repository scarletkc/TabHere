import type { InputContext } from "../shared/types";

const NO_SUGGESTION_TOKEN = "<NO_SUGGESTION>";

export function formatInputContextText(inputContext?: InputContext): string {
  if (!inputContext) return "";

  const parts: string[] = [];

  if (inputContext.label) {
    parts.push(`Label: ${inputContext.label}`);
  }
  if (inputContext.placeholder) {
    parts.push(`Placeholder: ${inputContext.placeholder}`);
  }
  if (inputContext.ariaLabel) {
    parts.push(`Aria-label: ${inputContext.ariaLabel}`);
  }
  if (inputContext.ariaDescription) {
    parts.push(`Description: ${inputContext.ariaDescription}`);
  }
  if (inputContext.fieldName) {
    parts.push(`Field name: ${inputContext.fieldName}`);
  }
  if (inputContext.nearbyHeading) {
    parts.push(`Section: ${inputContext.nearbyHeading}`);
  }
  if (inputContext.nearbyText) {
    parts.push(`Nearby text: ${inputContext.nearbyText}`);
  }

  return parts.length > 0 ? parts.join("\n") : "";
}

export function normalizeNoSuggestionOutput(text: unknown): string {
  const raw = String(text ?? "");
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed === NO_SUGGESTION_TOKEN) return "";
  return raw;
}

