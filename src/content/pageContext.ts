type PageContextOptions = {
  overlayAttr: string;
  maxContentChars: number;
  cacheTtlMs: number;
};

const MAX_TITLE_CHARS = 120;
const MAX_URL_CHARS = 300;

const SKIP_TEXT_PARENT_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "INPUT",
  "TEXTAREA",
  "SELECT",
  "OPTION",
  "BUTTON"
]);

export type PageContextForPrompt = {
  getPageTitleForPrompt: () => string;
  getPageUrlForPrompt: () => string;
  getPageContentForPrompt: (anchor: HTMLElement) => string | undefined;
};

export function createPageContextForPrompt(options: PageContextOptions): PageContextForPrompt {
  let cachedPageContentText: string | null = null;
  let cachedPageContentExpiresAt = 0;
  let cachedPageContentRoot: Element | null = null;

  function getPageTitleForPrompt(): string {
    const normalize = (title: string): string => {
      const text = title.replace(/\s+/g, " ").trim();
      if (!text) return "";
      return text.length > MAX_TITLE_CHARS ? text.slice(0, MAX_TITLE_CHARS) : text;
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

  function getPageUrlForPrompt(): string {
    const normalize = (href: string): string => {
      const text = String(href || "")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) return "";

      try {
        const url = new URL(text);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        const normalized = url.toString();
        return normalized.length > MAX_URL_CHARS ? normalized.slice(0, MAX_URL_CHARS) : normalized;
      } catch {
        return text.length > MAX_URL_CHARS ? text.slice(0, MAX_URL_CHARS) : text;
      }
    };

    try {
      const topHref = (window.top as Window | null | undefined)?.location?.href;
      if (typeof topHref === "string") {
        const normalized = normalize(topHref);
        if (normalized) return normalized;
      }
    } catch {
      // Ignore cross-origin access errors
    }

    const currentHref = normalize(location.href || "");
    if (currentHref) return currentHref;
    return normalize(location.origin || location.hostname) || "unknown";
  }

  function extractPageTextSnippet(root: ParentNode, exclude?: Element | null): string {
    const acceptNode = (node: Node): number => {
      const text = node.textContent;
      if (!text || !text.trim()) return NodeFilter.FILTER_REJECT;

      const parent = (node as any).parentElement as Element | null;
      if (!parent) return NodeFilter.FILTER_REJECT;

      if (parent.closest?.(`[${options.overlayAttr}]`)) return NodeFilter.FILTER_REJECT;
      if (SKIP_TEXT_PARENT_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (parent.closest?.("[hidden], [aria-hidden='true']")) return NodeFilter.FILTER_REJECT;
      // 排除当前输入框（尤其是 contenteditable）的内容，避免与 PREFIX/SUFFIX 重复
      if (exclude && exclude.contains(parent)) return NodeFilter.FILTER_REJECT;

      return NodeFilter.FILTER_ACCEPT;
    };

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode } as any);

    let out = "";
    let truncated = false;

    while (walker.nextNode()) {
      const raw = walker.currentNode.textContent || "";
      const cleaned = raw.replace(/\s+/g, " ").trim();
      if (!cleaned) continue;

      const separator = out ? " " : "";
      const available = options.maxContentChars - out.length - separator.length;
      if (available <= 0) {
        truncated = true;
        break;
      }

      if (cleaned.length > available) {
        out += separator + cleaned.slice(0, available);
        truncated = true;
        break;
      }

      out += separator + cleaned;
    }

    out = out.trim();
    if (!out) return "";

    if (truncated) {
      if (options.maxContentChars > 1 && out.length >= options.maxContentChars) {
        out = out.slice(0, options.maxContentChars - 1) + "…";
      } else if (out.length < options.maxContentChars) {
        out += "…";
      }
    }

    return out.length > options.maxContentChars ? out.slice(0, options.maxContentChars) : out;
  }

  function getPageContentForPrompt(anchor: HTMLElement): string | undefined {
    const root =
      anchor.closest("main, article, [role='main']") ||
      anchor.closest("form, [role='form']") ||
      document.querySelector("main, article, [role='main']") ||
      document.body ||
      document.documentElement;

    const now = Date.now();
    if (cachedPageContentText && cachedPageContentExpiresAt > now && cachedPageContentRoot === root) {
      return cachedPageContentText || undefined;
    }

    const snippet = root ? extractPageTextSnippet(root, anchor) : "";

    cachedPageContentText = snippet || "";
    cachedPageContentExpiresAt = now + options.cacheTtlMs;
    cachedPageContentRoot = root;
    return snippet || undefined;
  }

  return {
    getPageTitleForPrompt,
    getPageUrlForPrompt,
    getPageContentForPrompt
  };
}

