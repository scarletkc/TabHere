export type SuggestionRequestMessage = {
  type: "TABHERE_REQUEST_SUGGESTION";
  requestId: string;
  prefix: string;
  suffixContext?: string;
  cursorOffset?: number;
  languageHint?: string;
  url?: string;
  title?: string;
  maxOutputTokens?: number;
};

export type SuggestionResponseMessage = {
  type: "TABHERE_SUGGESTION";
  requestId: string;
  suffix: string;
  error?: string;
};

export type ShortcutKey = "Tab" | "CtrlSpace";

export type TabHereConfig = {
  apiKey?: string;
  model: string;
  baseUrl: string;
  maxOutputTokens: number;
  temperature: number;
  debounceMs: number;
  minTriggerChars: number;
  shortcutKey: ShortcutKey;
  sendUrl: boolean;
  sendTitle: boolean;
  useSync: boolean;
  disabledSites: string[];
  enabledSites: string[];
  disableOnSensitive: boolean;
};

