/**
 * 输入框邻近上下文信息
 * 用于提供更精准的 AI 补全
 */
export type InputContext = {
  /** 关联的 label 文本 */
  label?: string;
  /** placeholder 属性 */
  placeholder?: string;
  /** aria-label 属性 */
  ariaLabel?: string;
  /** aria-describedby 引用的描述文本 */
  ariaDescription?: string;
  /** 字段名 (name 或 id 属性) */
  fieldName?: string;
  /** 邻近的标题文本 (h1-h6, legend) */
  nearbyHeading?: string;
  /** 邻近的描述/提示文本 */
  nearbyText?: string;
};

export type SuggestionRequestMessage =
  | {
      type: "TABHERE_REQUEST_SUGGESTION";
      requestId: string;
      prefix: string;
      suffixContext?: string;
      pageTitle?: string;
      pageUrl?: string;
      /** 页面主体可见文本摘要（可选，截断后） */
      pageContent?: string;
      cursorOffset?: number;
      languageHint?: string;
      maxOutputTokens?: number;
      /** 输入框邻近上下文 */
      inputContext?: InputContext;
    }
  | {
      type: "TABHERE_REQUEST_REWRITE";
      requestId: string;
      prefix: string;
      selectedText: string;
      suffixContext?: string;
      pageTitle?: string;
      pageUrl?: string;
      /** 页面主体可见文本摘要（可选，截断后） */
      pageContent?: string;
      cursorOffset?: number;
      languageHint?: string;
      maxOutputTokens?: number;
      /** 输入框邻近上下文 */
      inputContext?: InputContext;
    };

export type SuggestionResponseMessage = {
  type: "TABHERE_SUGGESTION";
  requestId: string;
  suffix: string;
  error?: string;
};

export type TestApiRequestMessage = {
  type: "TABHERE_TEST_API";
  apiKey: string;
  baseUrl: string;
  model: string;
};

export type TestApiResponseMessage = {
  type: "TABHERE_TEST_API_RESULT";
  ok: boolean;
  message?: string;
};

export type ShortcutKey = "Tab" | "Shift" | "Ctrl";

export type TabHereConfig = {
  apiKey?: string;
  /** 用户个性化偏好/个人信息（可选），会注入到 system prompt */
  userInstructions: string;
  model: string;
  baseUrl: string;
  maxOutputTokens: number;
  temperature: number;
  debounceMs: number;
  minTriggerChars: number;
  shortcutKey: ShortcutKey;
  useSync: boolean;
  disabledSites: string[];
  enabledSites: string[];
  disableOnSensitive: boolean;
  /** 开发者调试模式：在控制台输出调试信息 */
  developerDebug: boolean;
};
