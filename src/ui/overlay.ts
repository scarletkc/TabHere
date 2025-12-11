export class SuggestionOverlay {
  private overlay: HTMLDivElement;

  constructor() {
    this.overlay = document.createElement("div");
    this.overlay.setAttribute("data-tabhare-overlay", "true");
    Object.assign(this.overlay.style, {
      position: "fixed",
      pointerEvents: "none",
      zIndex: "2147483647",
      color: "rgba(120,120,120,0.8)",
      whiteSpace: "pre-wrap",
      visibility: "hidden",
      maxWidth: "80vw"
    } as CSSStyleDeclaration);
    document.documentElement.appendChild(this.overlay);
  }

  public update(target: HTMLElement | null, suffix: string) {
    try {
      if (!target || !suffix) {
        this.hide();
        return;
      }

      const caretRect = getCaretRect(target);
      if (!caretRect) {
        this.hide();
        return;
      }

      const computed = window.getComputedStyle(target);
      this.overlay.style.fontFamily = computed.fontFamily;
      this.overlay.style.fontSize = computed.fontSize;
      this.overlay.style.fontWeight = computed.fontWeight;
      this.overlay.style.lineHeight = computed.lineHeight;
      this.overlay.style.letterSpacing = computed.letterSpacing;
      this.overlay.style.textAlign = computed.textAlign;

      this.overlay.textContent = suffix;
      this.overlay.style.left = `${caretRect.left}px`;
      this.overlay.style.top = `${caretRect.top}px`;
      this.overlay.style.visibility = "visible";
    } catch {
      this.hide();
    }
  }

  public hide() {
    this.overlay.textContent = "";
    this.overlay.style.visibility = "hidden";
  }

  public destroy() {
    this.overlay.remove();
  }
}

function getCaretRect(target: HTMLElement): DOMRect | null {
  if (target.isContentEditable) {
    return getContentEditableCaretRect(target);
  }

  const input = target as HTMLInputElement | HTMLTextAreaElement;
  const selectionStart = input.selectionStart ?? 0;
  return getTextInputCaretRect(input, selectionStart);
}

function getContentEditableCaretRect(target: HTMLElement): DOMRect | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return target.getBoundingClientRect();
  }

  const range = selection.getRangeAt(0).cloneRange();
  range.collapse(true);
  const rects = range.getClientRects();
  if (rects.length > 0) {
    return rects[0];
  }
  const rect = range.getBoundingClientRect();
  if (rect.width || rect.height) {
    return rect;
  }
  return target.getBoundingClientRect();
}

function getTextInputCaretRect(
  input: HTMLInputElement | HTMLTextAreaElement,
  caretIndex: number
): DOMRect | null {
  const computed = window.getComputedStyle(input);
  const mirror = document.createElement("div");
  const inputRect = input.getBoundingClientRect();

  mirror.style.position = "fixed";
  mirror.style.left = `${inputRect.left}px`;
  mirror.style.top = `${inputRect.top}px`;
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = input instanceof HTMLTextAreaElement ? "pre-wrap" : "pre";
  mirror.style.wordWrap = "break-word";
  mirror.style.overflow = "hidden";

  const propsToCopy = [
    "fontFamily",
    "fontSize",
    "fontWeight",
    "fontStyle",
    "letterSpacing",
    "textTransform",
    "lineHeight",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "boxSizing",
    "width",
    "height"
  ] as const;

  for (const prop of propsToCopy) {
    mirror.style[prop] = computed[prop];
  }

  const value = input.value ?? "";
  const before = value.slice(0, caretIndex);
  const after = value.slice(caretIndex);

  mirror.textContent = before;

  const marker = document.createElement("span");
  marker.textContent = after.length ? after[0] : "\u200b";
  mirror.appendChild(marker);

  document.body.appendChild(mirror);
  mirror.scrollTop = input.scrollTop;
  mirror.scrollLeft = input.scrollLeft;
  const markerRect = marker.getBoundingClientRect();
  mirror.remove();

  return new DOMRect(markerRect.left, markerRect.top, 0, markerRect.height || inputRect.height);
}
