import { SuggestionOverlay } from "./ui/overlay";
import type {
  InputContext,
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
/** 缓存的输入框上下文，焦点变化时失效 */
let cachedInputContext: InputContext | null = null;

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
  maxOutputTokens: 0,
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

function getSelectionSnapshot(el: HTMLElement): { prefix: string; selectedText: string; suffixContext: string } {
  if (el.isContentEditable) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      const fullText = getInputText(el);
      return { prefix: fullText, selectedText: "", suffixContext: "" };
    }
    const range = selection.getRangeAt(0);
    if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) {
      const fullText = getInputText(el);
      return { prefix: fullText, selectedText: "", suffixContext: "" };
    }

    const beforeRange = range.cloneRange();
    beforeRange.selectNodeContents(el);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    const prefix = beforeRange.toString();

    const selectedText = range.toString();

    const afterRange = range.cloneRange();
    afterRange.selectNodeContents(el);
    afterRange.setStart(range.endContainer, range.endOffset);
    const suffixContext = afterRange.toString();

    return { prefix, selectedText, suffixContext };
  }

  const input = el as HTMLInputElement | HTMLTextAreaElement;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const value = input.value || "";

  return {
    prefix: value.slice(0, start),
    selectedText: value.slice(start, end),
    suffixContext: value.slice(end)
  };
}

// ============ 输入框邻近上下文抓取 ============

/** 最大向上遍历 DOM 层级 */
const MAX_ANCESTOR_DEPTH = 5;
/** 最大邻近文本字符数 */
const MAX_NEARBY_TEXT_LENGTH = 500;

/**
 * 截断文本到指定长度
 */
function truncateText(text: string, maxLength: number): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.slice(0, maxLength) + "…";
}

/**
 * 获取关联的 label 文本
 * 支持 for 属性关联和父级包裹两种方式
 */
function getAssociatedLabel(el: HTMLElement): string | undefined {
  // 方式1: 通过 for 属性关联
  const id = el.id;
  if (id) {
    const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (label) {
      const text = label.textContent?.trim();
      if (text) return text;
    }
  }

  // 方式2: label 作为父元素包裹 input
  const parentLabel = el.closest("label");
  if (parentLabel) {
    // 获取 label 的文本，排除 input 本身的内容
    const clone = parentLabel.cloneNode(true) as HTMLElement;
    const inputs = clone.querySelectorAll("input, textarea, select");
    inputs.forEach((input) => input.remove());
    const text = clone.textContent?.trim();
    if (text) return text;
  }

  return undefined;
}

/**
 * 获取 placeholder 属性
 */
function getPlaceholder(el: HTMLElement): string | undefined {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const placeholder = el.placeholder?.trim();
    if (placeholder) return placeholder;
  }
  // contenteditable 可能有 data-placeholder
  const dataPlaceholder = el.getAttribute("data-placeholder")?.trim();
  if (dataPlaceholder) return dataPlaceholder;

  return undefined;
}

/**
 * 获取 aria-label
 */
function getAriaLabel(el: HTMLElement): string | undefined {
  return el.getAttribute("aria-label")?.trim() || undefined;
}

/**
 * 获取 aria-describedby 引用的描述文本
 */
function getAriaDescription(el: HTMLElement): string | undefined {
  const describedBy = el.getAttribute("aria-describedby");
  if (!describedBy) return undefined;

  const ids = describedBy.split(/\s+/).filter(Boolean);
  const texts: string[] = [];
  for (const id of ids) {
    const descEl = document.getElementById(id);
    if (descEl) {
      const text = descEl.textContent?.trim();
      if (text) texts.push(text);
    }
  }
  return texts.length > 0 ? texts.join(" ") : undefined;
}

/**
 * 获取字段名 (name 或 id 属性)
 */
function getFieldName(el: HTMLElement): string | undefined {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const name = el.name?.trim();
    if (name) return name;
  }
  const id = el.id?.trim();
  if (id) return id;

  return undefined;
}

/**
 * 向上遍历 DOM 寻找最近的标题元素
 */
function findNearbyHeading(el: HTMLElement): string | undefined {
  let current: HTMLElement | null = el;
  let depth = 0;

  while (current && depth < MAX_ANCESTOR_DEPTH) {
    // 检查 legend (fieldset 标题)
    if (current.tagName === "FIELDSET") {
      const legend = current.querySelector("legend");
      if (legend) {
        const text = legend.textContent?.trim();
        if (text) return text;
      }
    }

    // 在当前元素之前查找标题
    let sibling: Element | null = current.previousElementSibling;
    while (sibling) {
      if (/^H[1-6]$/.test(sibling.tagName)) {
        const text = sibling.textContent?.trim();
        if (text) return text;
      }
      // 也检查 legend
      if (sibling.tagName === "LEGEND") {
        const text = sibling.textContent?.trim();
        if (text) return text;
      }
      sibling = sibling.previousElementSibling;
    }

    current = current.parentElement;
    depth++;
  }

  // 最后尝试查找页面上最近的标题
  const headings = document.querySelectorAll("h1, h2, h3, h4, h5, h6");
  if (headings.length > 0) {
    // 返回最后一个标题（通常是最接近内容的）
    const lastHeading = headings[headings.length - 1];
    const text = lastHeading.textContent?.trim();
    if (text) return text;
  }

  return undefined;
}

/**
 * 获取邻近元素的描述/提示文本
 */
function findNearbyText(el: HTMLElement): string | undefined {
  const texts: string[] = [];
  let remaining = MAX_NEARBY_TEXT_LENGTH;

  // 收集前面的兄弟元素文本（最多2个）
  let prevSibling: Element | null = el.previousElementSibling;
  let prevCollected = 0;
  while (prevSibling && prevCollected < 2 && remaining > 0) {
    // 跳过脚本、样式和输入元素
    if (
      prevSibling.tagName === "SCRIPT" ||
      prevSibling.tagName === "STYLE" ||
      prevSibling.tagName === "INPUT" ||
      prevSibling.tagName === "TEXTAREA" ||
      prevSibling.tagName === "SELECT"
    ) {
      prevSibling = prevSibling.previousElementSibling;
      continue;
    }
    // 获取可见文本
    const text = prevSibling.textContent?.trim();
    if (text && text.length > 0) {
      const truncated = text.slice(0, remaining);
      texts.push(truncated);
      remaining -= truncated.length;
      prevCollected++;
    }
    prevSibling = prevSibling.previousElementSibling;
  }

  // 检查父元素中的直接文本节点
  if (remaining > 0 && el.parentElement) {
    const parent = el.parentElement;
    const childNodes = Array.from(parent.childNodes);
    for (const node of childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent?.trim();
        if (text && text.length > 0) {
          const truncated = text.slice(0, remaining);
          texts.push(truncated);
          remaining -= truncated.length;
          if (remaining <= 0) break;
        }
      }
    }
  }

  // 后面的兄弟元素（最多1个，通常是提示信息）
  if (remaining > 0) {
    const nextSibling = el.nextElementSibling;
    if (
      nextSibling &&
      nextSibling.tagName !== "SCRIPT" &&
      nextSibling.tagName !== "STYLE" &&
      nextSibling.tagName !== "INPUT" &&
      nextSibling.tagName !== "TEXTAREA"
    ) {
      const text = nextSibling.textContent?.trim();
      if (text && text.length > 0) {
        texts.push(text.slice(0, remaining));
      }
    }
  }

  const combined = texts.join(" ").trim();
  return combined.length > 0 ? truncateText(combined, MAX_NEARBY_TEXT_LENGTH) : undefined;
}

/**
 * 获取输入框的邻近上下文信息
 * 结果会被缓存，直到焦点变化
 */
function getInputNearbyContext(el: HTMLElement): InputContext {
  // 使用缓存
  if (cachedInputContext && currentInput === el) {
    return cachedInputContext;
  }

  const context: InputContext = {};

  // 获取各类上下文信息
  const label = getAssociatedLabel(el);
  if (label) context.label = truncateText(label, 200);

  const placeholder = getPlaceholder(el);
  if (placeholder) context.placeholder = truncateText(placeholder, 200);

  const ariaLabel = getAriaLabel(el);
  if (ariaLabel) context.ariaLabel = truncateText(ariaLabel, 200);

  const ariaDescription = getAriaDescription(el);
  if (ariaDescription) context.ariaDescription = truncateText(ariaDescription, 200);

  const fieldName = getFieldName(el);
  if (fieldName) context.fieldName = fieldName;

  const nearbyHeading = findNearbyHeading(el);
  if (nearbyHeading) context.nearbyHeading = truncateText(nearbyHeading, 200);

  const nearbyText = findNearbyText(el);
  if (nearbyText) context.nearbyText = nearbyText;

  // 缓存结果
  cachedInputContext = context;
  return context;
}

/**
 * 检查 InputContext 是否有实际内容
 */
function hasInputContext(ctx: InputContext): boolean {
  return !!(
    ctx.label ||
    ctx.placeholder ||
    ctx.ariaLabel ||
    ctx.ariaDescription ||
    ctx.fieldName ||
    ctx.nearbyHeading ||
    ctx.nearbyText
  );
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

function getPageTitleForPrompt(): string {
  const normalize = (title: string): string => {
    const text = title.replace(/\s+/g, " ").trim();
    if (!text) return "";
    return text.length > 120 ? text.slice(0, 120) : text;
  };

  try {
    const topTitle = (window.top as Window | null | undefined)?.document?.title;
    if (typeof topTitle === "string") {
      const normalized = normalize(topTitle);
      if (normalized) return normalized;
    }
  } catch {
    // Ignore cross-origin access errors
  }

  const currentTitle = normalize(document.title || "");
  if (currentTitle) return currentTitle;
  return normalize(location.hostname) || "WebInput";
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

    const { prefix, selectedText, suffixContext } = getSelectionSnapshot(currentInput);
    const hasSelection = selectedText.length > 0;

    if (hasSelection) {
      if (selectedText.trim().length === 0) {
        clearSuggestion();
        return;
      }
    } else if (prefix.trim().length < config.minTriggerChars) {
      clearSuggestion();
      return;
    }

    const now = Date.now();
    if (now - lastFailureAt < 3000) {
      return;
    }

    const requestId = crypto.randomUUID();
    latestRequestId = requestId;

    // 获取输入框邻近上下文
    const inputContext = getInputNearbyContext(currentInput);

    const message: SuggestionRequestMessage = hasSelection
      ? {
          type: "TABHERE_REQUEST_REWRITE",
          requestId,
          prefix,
          selectedText,
          suffixContext,
          pageTitle: getPageTitleForPrompt(),
          maxOutputTokens: config.maxOutputTokens,
          inputContext: hasInputContext(inputContext) ? inputContext : undefined
        }
      : {
          type: "TABHERE_REQUEST_SUGGESTION",
          requestId,
          prefix,
          suffixContext,
          pageTitle: getPageTitleForPrompt(),
          maxOutputTokens: config.maxOutputTokens,
          inputContext: hasInputContext(inputContext) ? inputContext : undefined
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
    cachedInputContext = null; // 清除上下文缓存
    clearSuggestion();
    return;
  }
  if (config && (!isSiteAllowed(config) || isSensitiveInput(editable, config))) {
    currentInput = null;
    cachedInputContext = null; // 清除上下文缓存
    clearSuggestion();
    return;
  }
  // 焦点变化时清除上下文缓存
  if (currentInput !== editable) {
    cachedInputContext = null;
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
    cachedInputContext = null; // 清除上下文缓存
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

function handleSelect(event: Event) {
  const editable = getEditableFromEvent(event);
  if (!editable) return;
  if (config && (isSensitiveInput(editable, config) || !isSiteAllowed(config))) return;

  currentInput = editable;
  clearSuggestion();
  scheduleSuggest();
}

document.addEventListener("select", handleSelect, true);
window.addEventListener("select", handleSelect, true);

function handleMouseUp(event: Event) {
  const editable = getEditableFromEvent(event);
  if (!editable) return;
  if (config && (isSensitiveInput(editable, config) || !isSiteAllowed(config))) return;

  const { selectedText } = getSelectionSnapshot(editable);
  if (!selectedText) return;

  currentInput = editable;
  clearSuggestion();
  scheduleSuggest();
}

document.addEventListener("mouseup", handleMouseUp, true);
window.addEventListener("mouseup", handleMouseUp, true);

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
