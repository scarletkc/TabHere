import { SuggestionOverlay } from "./ui/overlay";
import type {
  SuggestionRequestMessage,
  SuggestionResponseMessage,
  TabHereConfig
} from "./shared/types";

let currentInput: HTMLElement | null = null;
let currentSuggestionSuffix = "";
let latestRequestId: string | null = null;
let isComposing = false;
let debounceTimer: number | null = null;
let config: TabHereConfig | null = null;
let lastFailureAt = 0;
let contextInvalidated = false;

const overlay = new SuggestionOverlay();

type RuntimeLike = {
  sendMessage: typeof chrome.runtime.sendMessage;
};

function getRuntime(): RuntimeLike | null {
  const anyGlobal = globalThis as any;
  const runtime = (anyGlobal.chrome && anyGlobal.chrome.runtime) || (anyGlobal.browser && anyGlobal.browser.runtime);
  return runtime && typeof runtime.sendMessage === "function" ? (runtime as RuntimeLike) : null;
}

async function refreshConfig() {
  if (contextInvalidated) return;
  try {
    config = await getConfigLocal();
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      contextInvalidated = true;
      config = null;
      clearSuggestion();
      return;
    }
    throw error;
  }
}

refreshConfig().catch(console.error);
chrome.storage.onChanged.addListener(() => {
  refreshConfig().catch(console.error);
});

const DEFAULT_CONFIG: TabHereConfig = {
  apiKey: undefined,
  model: "gpt-5.2-mini",
  baseUrl: "https://api.openai.com/v1",
  maxOutputTokens: 64,
  temperature: 0.2,
  debounceMs: 500,
  minTriggerChars: 3,
  shortcutKey: "Tab",
  useSync: true,
  disabledSites: [],
  enabledSites: [],
  disableOnSensitive: true
};

const CONFIG_KEYS = [
  "tabhere_api_key",
  "tabhere_model",
  "tabhere_base_url",
  "tabhere_max_output_tokens",
  "tabhere_temperature",
  "tabhere_debounce_ms",
  "tabhere_min_trigger_chars",
  "tabhere_shortcut_key",
  "tabhere_use_sync",
  "tabhere_disabled_sites",
  "tabhere_enabled_sites",
  "tabhere_disable_on_sensitive"
] as const;

type ConfigStorageShape = {
  tabhere_api_key?: string;
  tabhere_model?: string;
  tabhere_base_url?: string;
  tabhere_max_output_tokens?: number;
  tabhere_temperature?: number;
  tabhere_debounce_ms?: number;
  tabhere_min_trigger_chars?: number;
  tabhere_shortcut_key?: TabHereConfig["shortcutKey"];
  tabhere_use_sync?: boolean;
  tabhere_disabled_sites?: string[];
  tabhere_enabled_sites?: string[];
  tabhere_disable_on_sensitive?: boolean;
};

function storageGet<T>(area: chrome.storage.StorageArea, keys: readonly string[]): Promise<T> {
  return new Promise((resolve) => {
    try {
      area.get(keys as any, (res) => resolve(res as T));
    } catch (error) {
      if (isExtensionContextInvalidated(error)) {
        contextInvalidated = true;
      }
      resolve({} as T);
    }
  });
}

async function getConfigLocal(): Promise<TabHereConfig> {
  const useSyncRes = await storageGet<Pick<ConfigStorageShape, "tabhere_use_sync">>(
    chrome.storage.sync,
    ["tabhere_use_sync"]
  );
  const useSync = useSyncRes.tabhere_use_sync ?? DEFAULT_CONFIG.useSync;
  const storage = useSync ? chrome.storage.sync : chrome.storage.local;
  const res = await storageGet<ConfigStorageShape>(storage, CONFIG_KEYS);

  return {
    apiKey: res.tabhere_api_key,
    model: res.tabhere_model || DEFAULT_CONFIG.model,
    baseUrl: res.tabhere_base_url || DEFAULT_CONFIG.baseUrl,
    maxOutputTokens: res.tabhere_max_output_tokens ?? DEFAULT_CONFIG.maxOutputTokens,
    temperature: res.tabhere_temperature ?? DEFAULT_CONFIG.temperature,
    debounceMs: res.tabhere_debounce_ms ?? DEFAULT_CONFIG.debounceMs,
    minTriggerChars: res.tabhere_min_trigger_chars ?? DEFAULT_CONFIG.minTriggerChars,
    shortcutKey: res.tabhere_shortcut_key || DEFAULT_CONFIG.shortcutKey,
    useSync,
    disabledSites: res.tabhere_disabled_sites ?? DEFAULT_CONFIG.disabledSites,
    enabledSites: res.tabhere_enabled_sites ?? DEFAULT_CONFIG.enabledSites,
    disableOnSensitive: res.tabhere_disable_on_sensitive ?? DEFAULT_CONFIG.disableOnSensitive
  };
}

function getEventTarget(event: Event): HTMLElement | null {
  const path = (event as any).composedPath?.() as EventTarget[] | undefined;
  const target = (path && path[0]) || event.target;
  return target instanceof HTMLElement ? target : null;
}

const OVERLAY_ATTR = "data-tabhare-overlay";

function findContentEditableRoot(el: HTMLElement): HTMLElement {
  let node: HTMLElement | null = el;
  let root: HTMLElement = el;
  while (node && node.isContentEditable) {
    if (node.getAttribute("contenteditable") !== null) {
      root = node;
    }
    node = node.parentElement;
  }
  return root;
}

function resolveEditableTarget(el: HTMLElement | null): HTMLElement | null {
  if (!el) return null;
  if (el.closest?.(`[${OVERLAY_ATTR}]`)) return null;

  if (isEditableElement(el)) {
    return el.isContentEditable ? findContentEditableRoot(el) : el;
  }

  const ancestor = el.closest?.(
    "textarea, input, [contenteditable='true'], [contenteditable=''], [contenteditable='plaintext-only']"
  ) as HTMLElement | null;

  if (ancestor && isEditableElement(ancestor)) {
    return ancestor.isContentEditable ? findContentEditableRoot(ancestor) : ancestor;
  }

  return null;
}

function getEditableFromEvent(event: Event): HTMLElement | null {
  const direct = resolveEditableTarget(getEventTarget(event));
  if (direct) return direct;

  const path = (event as any).composedPath?.() as EventTarget[] | undefined;
  if (path) {
    for (const node of path) {
      if (node instanceof HTMLElement) {
        const resolved = resolveEditableTarget(node);
        if (resolved) return resolved;
      }
    }
  }
  return null;
}

function isSensitiveInput(el: HTMLElement, cfg: TabHereConfig): boolean {
  if (!cfg.disableOnSensitive) {
    return false;
  }
  if (el instanceof HTMLInputElement) {
    const type = (el.type || "").toLowerCase();
    if (type === "password") return true;
  }
  const autocomplete = el.getAttribute("autocomplete") || "";
  const sensitiveAutocomplete = [
    "one-time-code",
    "cc-number",
    "cc-csc",
    "cc-exp",
    "new-password",
    "current-password"
  ];
  return sensitiveAutocomplete.some((key) => autocomplete.includes(key));
}

function isEditableElement(el: HTMLElement): boolean {
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    const type = (el.type || "text").toLowerCase();
    const allowedTypes = ["text", "search", "email", "url", "tel", "number"];
    return allowedTypes.includes(type);
  }
  return false;
}

function isSiteAllowed(cfg: TabHereConfig): boolean {
  const host = location.hostname;
  if (cfg.disabledSites.some((d) => host === d || host.endsWith(`.${d}`))) {
    return false;
  }
  if (cfg.enabledSites.length > 0) {
    return cfg.enabledSites.some((d) => host === d || host.endsWith(`.${d}`));
  }
  return true;
}

function getInputText(el: HTMLElement): string {
  if (el.isContentEditable) {
    return el.innerText || "";
  }
  return (el as HTMLInputElement | HTMLTextAreaElement).value || "";
}

function getPrefixSuffixAtCaret(el: HTMLElement): { prefix: string; suffixContext: string } {
  if (el.isContentEditable) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      const fullText = getInputText(el);
      return { prefix: fullText, suffixContext: "" };
    }
    const range = selection.getRangeAt(0);
    const beforeRange = range.cloneRange();
    beforeRange.selectNodeContents(el);
    beforeRange.setEnd(range.endContainer, range.endOffset);
    const prefix = beforeRange.toString();

    const afterRange = range.cloneRange();
    afterRange.selectNodeContents(el);
    afterRange.setStart(range.endContainer, range.endOffset);
    const suffixContext = afterRange.toString();
    return { prefix, suffixContext };
  }

  const input = el as HTMLInputElement | HTMLTextAreaElement;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const value = input.value || "";
  return {
    prefix: value.slice(0, start),
    suffixContext: value.slice(end)
  };
}

function applySuggestion(el: HTMLElement, suffix: string) {
  if (!suffix) return;
  if (el.isContentEditable) {
    el.focus();
    try {
      if (typeof document.execCommand === "function") {
        const ok = document.execCommand("insertText", false, suffix);
        if (ok) {
          return;
        }
      }
    } catch {
      // fall through to manual insertion
    }
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      el.innerText = (el.innerText || "") + suffix;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const textNode = document.createTextNode(suffix);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.setEndAfter(textNode);
    selection.removeAllRanges();
    selection.addRange(range);
    if (typeof InputEvent !== "undefined") {
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          data: suffix,
          inputType: "insertText"
        } as any)
      );
    } else {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return;
  }

  const input = el as HTMLInputElement | HTMLTextAreaElement;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const value = input.value || "";
  const nextValue = value.slice(0, start) + suffix + value.slice(end);
  setNativeValue(input, nextValue);
  const caret = start + suffix.length;
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setNativeValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  let proto: any = input;
  while (proto) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor?.set) {
      descriptor.set.call(input, value);
      return;
    }
    proto = Object.getPrototypeOf(proto);
  }
  input.value = value;
}

function clearSuggestion() {
  currentSuggestionSuffix = "";
  overlay.hide();
}

function scheduleSuggest() {
  if (!currentInput || !config) return;
  if (contextInvalidated) return;
  if (!isSiteAllowed(config)) return;
  if (isSensitiveInput(currentInput, config)) return;

  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  debounceTimer = window.setTimeout(() => {
    if (!currentInput || !config) return;
    if (isComposing) return;

    const { prefix, suffixContext } = getPrefixSuffixAtCaret(currentInput);
    if (prefix.trim().length < config.minTriggerChars) {
      clearSuggestion();
      return;
    }

    const now = Date.now();
    if (now - lastFailureAt < 3000) {
      return;
    }

    const requestId = crypto.randomUUID();
    latestRequestId = requestId;

    const message: SuggestionRequestMessage = {
      type: "TABHERE_REQUEST_SUGGESTION",
      requestId,
      prefix,
      suffixContext,
      maxOutputTokens: config.maxOutputTokens
    };

    const runtime = getRuntime();
    if (!runtime) {
      clearSuggestion();
      return;
    }
    try {
      runtime.sendMessage(message, (res: SuggestionResponseMessage) => {
        if (!res || res.error || res.requestId !== latestRequestId) {
          lastFailureAt = Date.now();
          clearSuggestion();
          return;
        }
        currentSuggestionSuffix = res.suffix || "";
        overlay.update(currentInput, currentSuggestionSuffix);
      });
    } catch (error) {
      if (isExtensionContextInvalidated(error)) {
        contextInvalidated = true;
        clearSuggestion();
      }
    }
  }, config.debounceMs);
}

function handleFocusIn(event: Event) {
  const editable = getEditableFromEvent(event);
  if (!editable) {
    currentInput = null;
    clearSuggestion();
    return;
  }
  if (config && (!isSiteAllowed(config) || isSensitiveInput(editable, config))) {
    currentInput = null;
    clearSuggestion();
    return;
  }
  currentInput = editable;
  clearSuggestion();
  scheduleSuggest();
}

document.addEventListener("focusin", handleFocusIn, true);
window.addEventListener("focusin", handleFocusIn, true);

document.addEventListener(
  "focusout",
  (event) => {
    const nextTarget = (event as FocusEvent).relatedTarget as HTMLElement | null;
    if (currentInput && nextTarget && currentInput.contains(nextTarget)) {
      return;
    }
    currentInput = null;
    clearSuggestion();
  },
  true
);

function handleInput(event: Event) {
  const editable = getEditableFromEvent(event);
  if (!editable) return;
  currentInput = editable;
  clearSuggestion();
  scheduleSuggest();
}

document.addEventListener("input", handleInput, true);
window.addEventListener("input", handleInput, true);

function handleBeforeInput(event: Event) {
  const editable = getEditableFromEvent(event);
  if (!editable) return;
  currentInput = editable;
  clearSuggestion();
  scheduleSuggest();
}

document.addEventListener("beforeinput", handleBeforeInput, true);
window.addEventListener("beforeinput", handleBeforeInput, true);

function handleKeyup(event: Event) {
  const editable = getEditableFromEvent(event);
  if (!editable) return;

  const keyEvent = event as KeyboardEvent;
  const isEditingKey =
    keyEvent.key.length === 1 ||
    keyEvent.key === "Backspace" ||
    keyEvent.key === "Delete" ||
    keyEvent.key === "Enter";
  if (!isEditingKey) return;

  currentInput = editable;
  clearSuggestion();
  scheduleSuggest();
}

document.addEventListener("keyup", handleKeyup, true);
window.addEventListener("keyup", handleKeyup, true);

document.addEventListener(
  "selectionchange",
  () => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const anchorNode = selection.anchorNode;
    if (!anchorNode) return;
    const anchorElement =
      anchorNode instanceof HTMLElement ? anchorNode : anchorNode.parentElement;
    if (!anchorElement) return;

    const editable = resolveEditableTarget(anchorElement);
    if (!editable) return;
    if (config && (isSensitiveInput(editable, config) || !isSiteAllowed(config))) return;

    currentInput = editable;
    clearSuggestion();
    scheduleSuggest();
  },
  true
);

document.addEventListener(
  "compositionstart",
  () => {
    isComposing = true;
  },
  true
);

document.addEventListener(
  "compositionend",
  () => {
    isComposing = false;
    scheduleSuggest();
  },
  true
);

document.addEventListener(
  "keydown",
  handleKeydown,
  true
);

window.addEventListener("keydown", handleKeydown, true);

function handleKeydown(event: KeyboardEvent) {
  if (!currentInput || !config) return;
  if (!currentSuggestionSuffix) return;
  if (contextInvalidated) return;

  const isTabShortcut =
    config.shortcutKey === "Tab" && event.key === "Tab" && !event.ctrlKey && !event.metaKey;
  const isCtrlSpaceShortcut =
    config.shortcutKey === "CtrlSpace" &&
    event.ctrlKey &&
    (event.code === "Space" || event.key === " " || event.key === "Spacebar" || event.key === "Space");

  const shortcutMatches = isTabShortcut || isCtrlSpaceShortcut;

  if (shortcutMatches) {
    event.preventDefault();
    applySuggestion(currentInput, currentSuggestionSuffix);
    clearSuggestion();
  } else if (event.key === "Escape") {
    clearSuggestion();
  }
}

function isExtensionContextInvalidated(error: unknown): boolean {
  return (
    error instanceof Error &&
    typeof error.message === "string" &&
    error.message.includes("Extension context invalidated")
  );
}

window.addEventListener(
  "scroll",
  () => {
    if (currentInput && currentSuggestionSuffix) {
      overlay.update(currentInput, currentSuggestionSuffix);
    }
  },
  true
);

window.addEventListener("resize", () => {
  if (currentInput && currentSuggestionSuffix) {
    overlay.update(currentInput, currentSuggestionSuffix);
  }
});
