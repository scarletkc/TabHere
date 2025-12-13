import OpenAI from "openai";
import { getConfig } from "./shared/config";
import { EMPTY_PLACEHOLDER, formatInputContextText, NO_SUGGESTION_TOKEN } from "./shared/promptUtils";
import type {
  InputContext,
  SuggestionRequestMessage,
  SuggestionResponseMessage,
  TestApiRequestMessage,
  TestApiResponseMessage
} from "./shared/types";

type ClientCache = {
  apiKey?: string;
  baseUrl?: string;
  client?: OpenAI;
};

const clientCache: ClientCache = {};

type SuggestionCacheEntry = {
  value: string;
  expiresAt: number;
};

const SUGGESTION_CACHE_MAX_ENTRIES = 200;
const SUGGESTION_CACHE_TTL_MS = 30_000;
const SUGGESTION_CACHE_MAX_CONTEXT_CHARS = 4096;

const suggestionCache = new Map<string, SuggestionCacheEntry>();
const inflightSuggestions = new Map<string, Promise<string>>();

type RequestIntent = "suggest" | "rewrite";

const actionApi: any = (chrome as any).action || (chrome as any).browserAction;
if (actionApi?.onClicked) {
  actionApi.onClicked.addListener(() => {
    chrome.runtime.openOptionsPage();
  });
}

function fnv1a64Hex(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

function normalizePageTitle(pageTitle: string | undefined): string {
  const text = String(pageTitle ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "WebInput";
  return text.length > 120 ? text.slice(0, 120) : text;
}

function normalizePageUrl(pageUrl: string | undefined): string {
  const text = String(pageUrl ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "unknown";
  return text.length > 300 ? text.slice(0, 300) : text;
}

function normalizePageContent(pageContent: string | undefined): string {
  const text = String(pageContent ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.length > 1000 ? text.slice(0, 1000) : text;
}

function formatLocalTimeHour(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = now.getHours();
  const period = hours < 12 ? "AM" : "PM";
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  const hour12Text = String(hour12).padStart(2, "0");
  return `${year}-${month}-${day} ${hour12Text}${period}`;
}

function buildSuggestionCacheKey(
  config: Awaited<ReturnType<typeof getConfig>>,
  intent: RequestIntent,
  prefix: string,
  selectedText?: string,
  suffixContext?: string,
  pageTitle?: string,
  pageUrl?: string,
  pageContent?: string,
  inputContext?: InputContext
): string | null {
  const selected = selectedText ?? "";
  const suffix = suffixContext ?? "";
  const title = normalizePageTitle(pageTitle);
  const url = normalizePageUrl(pageUrl);
  const content = normalizePageContent(pageContent);
  const localTime = formatLocalTimeHour();
  const userInstructions = config.userInstructions || "";
  const inputContextText = formatInputContextText(inputContext);

  if (
    prefix.length +
      selected.length +
      suffix.length +
      title.length +
      url.length +
      content.length +
      localTime.length +
      userInstructions.length +
      inputContextText.length >
    SUGGESTION_CACHE_MAX_CONTEXT_CHARS
  ) {
    return null;
  }

  return JSON.stringify({
    v: 8,
    intent,
    baseUrl: config.baseUrl,
    model: config.model,
    temperature: config.temperature,
    maxOutputTokens: config.maxOutputTokens,
    titleLen: title.length,
    titleHash: fnv1a64Hex(title),
    urlLen: url.length,
    urlHash: fnv1a64Hex(url),
    contentLen: content.length,
    contentHash: fnv1a64Hex(content),
    localTimeLen: localTime.length,
    localTimeHash: fnv1a64Hex(localTime),
    userInstructionsLen: userInstructions.length,
    userInstructionsHash: fnv1a64Hex(userInstructions),
    prefixLen: prefix.length,
    prefixHash: fnv1a64Hex(prefix),
    selectedLen: selected.length,
    selectedHash: fnv1a64Hex(selected),
    suffixLen: suffix.length,
    suffixHash: fnv1a64Hex(suffix),
    inputContextLen: inputContextText.length,
    inputContextHash: fnv1a64Hex(inputContextText)
  });
}

function getCachedSuggestion(cacheKey: string): string | null {
  const entry = suggestionCache.get(cacheKey);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    suggestionCache.delete(cacheKey);
    return null;
  }

  // Refresh LRU order
  suggestionCache.delete(cacheKey);
  suggestionCache.set(cacheKey, entry);
  return entry.value;
}

function setCachedSuggestion(cacheKey: string, value: string) {
  suggestionCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + SUGGESTION_CACHE_TTL_MS
  });

  while (suggestionCache.size > SUGGESTION_CACHE_MAX_ENTRIES) {
    const oldestKey = suggestionCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    suggestionCache.delete(oldestKey);
  }
}

async function createOpenAIClient(): Promise<OpenAI> {
  const { apiKey, baseUrl } = await getConfig();
  if (!apiKey) {
    throw new Error("NO_API_KEY");
  }

  if (clientCache.client && clientCache.apiKey === apiKey && clientCache.baseUrl === baseUrl) {
    return clientCache.client;
  }

  const client = new OpenAI({
    apiKey,
    baseURL: baseUrl,
    dangerouslyAllowBrowser: true
  });

  clientCache.apiKey = apiKey;
  clientCache.baseUrl = baseUrl;
  clientCache.client = client;
  return client;
}

function extractOutputText(resp: any): string {
  if (typeof resp?.output_text === "string") {
    return resp.output_text;
  }
  const output = resp?.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part?.type === "output_text" && typeof part?.text === "string") {
            return part.text;
          }
        }
      }
    }
  }
  return "";
}

function normalizeModelOutput(text: string, intent: RequestIntent, selectedText?: string): string {
  const raw = String(text ?? "");
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed === NO_SUGGESTION_TOKEN) return "";
  if (intent === "rewrite" && raw === String(selectedText ?? "")) return "";
  return raw;
}

type PromptParts = {
  system: string;
  user: string;
};

function buildInputContextSection(inputContextText: string, intent: RequestIntent): string {
  if (!inputContextText) return "";

  const tail =
    intent === "rewrite"
      ? "rewrite accordingly."
      : "provide more relevant completions.";

  return `
Additionally, you are given context about the input field:
<INPUT-CONTEXT>
${inputContextText}
</INPUT-CONTEXT>
Use this context to understand what kind of content the user is entering (e.g., email subject, recipient name, message body, search query, etc.) and ${tail}
`;
}

function buildUserInstructionsSection(userInstructionsText: string): string {
  if (!userInstructionsText) return "";
  return `
The user provided personalization preferences and/or personal information:
<USER-INSTRUCTIONS>
${userInstructionsText}
</USER-INSTRUCTIONS>
Use this to match tone, formatting, and relevant personal details when appropriate.
Do not reveal or quote this section in your output.
`;
}

function buildSuggestionPrompt(
  prefix: string,
  suffixContext?: string,
  pageTitle?: string,
  pageUrl?: string,
  pageContent?: string,
  inputContext?: InputContext,
  userInstructions?: string
): PromptParts {
  const inputContextText = formatInputContextText(inputContext);
  const title = normalizePageTitle(pageTitle);
  const url = normalizePageUrl(pageUrl);
  const content = normalizePageContent(pageContent);
  const suffix = suffixContext ?? "";
  const localTime = formatLocalTimeHour();
  const userInstructionsText = String(userInstructions ?? "").trim();
  
  const inputContextSection = buildInputContextSection(inputContextText, "suggest");
  const userInstructionsSection = buildUserInstructionsSection(userInstructionsText);

  const system = `You are an intelligent input-method completion engine.
You will receive the text before and after the cursor (<PREFIX> and <SUFFIX>).
Your task: output ONLY the text that should be inserted at <CURSOR> so that
<PREFIX> + your output + <SUFFIX> is coherent and natural.

Strict requirements:
- Output only the insertion text. No explanations, no quotes, no Markdown fences. 
- If no insertion is needed, output exactly <NO_SUGGESTION> (including angle brackets) and nothing else.
- Do not output any tags except the literal <NO_SUGGESTION> token when no insertion is needed.
- Do not repeat or rewrite any part of <PREFIX> or <SUFFIX>.
- Do not answer questions or add commentary.
- Match the surrounding language, style, punctuation, and formatting (including newlines, spaces).
- Keep the insertion moderately short unless the context clearly requires longer.
- It should conform to the context of [PAGE-TITLE], [PAGE-URL], and [PAGE-CONTENT].
${inputContextSection}
${userInstructionsSection}
[LANGUAGE]: Auto
[LOCAL-TIME]: ${localTime}
[PAGE-TITLE]: ${title}
[PAGE-URL]: ${url}
[PAGE-CONTENT]: ${content || EMPTY_PLACEHOLDER}
`;

  const user = [
    "<PREFIX>",
    prefix,
    "</PREFIX>",
    "",
    "<CURSOR>",
    "",
    "<SUFFIX>",
    suffix,
    "</SUFFIX>",
    "",
    "Output only the text to insert at <CURSOR>:"
  ].join("\n");
  return { system, user };
}

function buildRewritePrompt(
  prefix: string,
  selectedText: string,
  suffixContext?: string,
  pageTitle?: string,
  pageUrl?: string,
  pageContent?: string,
  inputContext?: InputContext,
  userInstructions?: string
): PromptParts {
  const inputContextText = formatInputContextText(inputContext);
  const title = normalizePageTitle(pageTitle);
  const url = normalizePageUrl(pageUrl);
  const content = normalizePageContent(pageContent);
  const suffix = suffixContext ?? "";
  const localTime = formatLocalTimeHour();
  const userInstructionsText = String(userInstructions ?? "").trim();

  const inputContextSection = buildInputContextSection(inputContextText, "rewrite");
  const userInstructionsSection = buildUserInstructionsSection(userInstructionsText);

  const system = `You are an intelligent in-place rewrite engine.
You will receive the text before and after a selected region (<PREFIX> and <SUFFIX>), plus the selected text (<SELECTED>).
Your task: output ONLY the rewritten replacement text for <SELECTED> so that
<PREFIX> + your output + <SUFFIX> is coherent and natural.

Strict requirements:
- Output only the replacement text. No explanations, no quotes, no Markdown fences.
- If no rewrite is needed, output exactly <NO_SUGGESTION> (including angle brackets) and nothing else.
- Do not output any tags except the literal <NO_SUGGESTION> token when no rewrite is needed.
- Do not repeat or rewrite any part of <PREFIX> or <SUFFIX>.
- Preserve the meaning of <SELECTED> unless the surrounding context clearly indicates a correction is needed.
- Match the surrounding language, style, punctuation, and formatting (including newlines, spaces).
- Keep the replacement reasonably similar length unless the context clearly requires longer/shorter.
- It should conform to the context of [PAGE-TITLE], [PAGE-URL], and [PAGE-CONTENT].
${inputContextSection}
${userInstructionsSection}
[LANGUAGE]: Auto
[LOCAL-TIME]: ${localTime}
[PAGE-TITLE]: ${title}
[PAGE-URL]: ${url}
[PAGE-CONTENT]: ${content || EMPTY_PLACEHOLDER}
`;

  const user = [
    "<PREFIX>",
    prefix,
    "</PREFIX>",
    "",
    "<SELECTED>",
    selectedText,
    "</SELECTED>",
    "",
    "<SUFFIX>",
    suffix,
    "</SUFFIX>",
    "",
    "Output only the replacement text for <SELECTED>:"
  ].join("\n");

  return { system, user };
}

function isResponsesUnsupported(error: any): boolean {
  const status = error?.status ?? error?.response?.status;
  if (status === 404 || status === 405) return true;
  const message = String(error?.message || "").toLowerCase();
  return message.includes("not found") && message.includes("404");
}

function describeApiTestError(error: any): string {
  const status = error?.status ?? error?.response?.status;
  const rawMessage = String(error?.message || error?.error?.message || "").trim();

  if (rawMessage === "NO_API_KEY") return "Missing API key";

  if (status === 401) return "Unauthorized (check API key)";
  if (status === 403) return "Forbidden (key has no access)";
  if (status === 404) return "Not found (check Base URL and model)";
  if (status === 429) return "Rate limited or quota exceeded";
  if (status === 400) return "Bad request (check model/Base URL)";

  const lower = rawMessage.toLowerCase();
  if (lower.includes("failed to fetch") || lower.includes("networkerror")) {
    return "Network error (check Base URL and connectivity)";
  }

  if (status) {
    return `Request failed (HTTP ${status})${rawMessage ? `: ${rawMessage}` : ""}`;
  }

  return rawMessage || "Unknown error";
}

async function testApiConfig(apiKey: string, baseUrl: string, model: string) {
  const client = new OpenAI({
    apiKey,
    baseURL: baseUrl,
    dangerouslyAllowBrowser: true
  });

  try {
    await client.models.retrieve(model);
    return;
  } catch (error: any) {
    const status = error?.status ?? error?.response?.status;
    if (status && status !== 404 && status !== 405) {
      throw error;
    }
  }

  try {
    await client.responses.create({
      model,
      input: [{ role: "user", content: "ping" }],
      max_output_tokens: 1
    } as any);
    return;
  } catch (error: any) {
    if (!isResponsesUnsupported(error)) {
      throw error;
    }
  }

  await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 1
  } as any);
}

async function requestWithResponses(
  client: OpenAI,
  config: Awaited<ReturnType<typeof getConfig>>,
  prompt: PromptParts
): Promise<string> {
  const req: any = {
    model: config.model,
    temperature: config.temperature,
    input: [
      {
        role: "system",
        content: prompt.system
      },
      {
        role: "user",
        content: prompt.user
      }
    ]
  };
  if (Number.isInteger(config.maxOutputTokens) && config.maxOutputTokens > 0) {
    req.max_output_tokens = config.maxOutputTokens;
  }

  const resp = await client.responses.create(req);

  return extractOutputText(resp);
}

async function requestWithChat(
  client: OpenAI,
  config: Awaited<ReturnType<typeof getConfig>>,
  prompt: PromptParts
): Promise<string> {
  const req: any = {
    model: config.model,
    temperature: config.temperature,
    messages: [
      {
        role: "system",
        content: prompt.system
      },
      {
        role: "user",
        content: prompt.user
      }
    ]
  };
  if (Number.isInteger(config.maxOutputTokens) && config.maxOutputTokens > 0) {
    req.max_tokens = config.maxOutputTokens;
  }

  const resp = await client.chat.completions.create(req);

  const text = resp?.choices?.[0]?.message?.content ?? "";
  return String(text);
}

chrome.runtime.onMessage.addListener(
  (
    message: SuggestionRequestMessage | TestApiRequestMessage,
    _sender,
    sendResponse: (res: SuggestionResponseMessage | TestApiResponseMessage) => void
  ) => {
    if (message?.type === "TABHERE_TEST_API") {
      (async () => {
        try {
          const { apiKey, baseUrl, model } = message;
          if (!apiKey) {
            sendResponse({ type: "TABHERE_TEST_API_RESULT", ok: false, message: "Missing API key" });
            return;
          }
          await testApiConfig(apiKey, baseUrl, model);
          sendResponse({ type: "TABHERE_TEST_API_RESULT", ok: true });
        } catch (error: any) {
          sendResponse({ type: "TABHERE_TEST_API_RESULT", ok: false, message: describeApiTestError(error) });
        }
      })();
      return true;
    }

    if (message?.type !== "TABHERE_REQUEST_SUGGESTION" && message?.type !== "TABHERE_REQUEST_REWRITE") {
      return;
    }

    (async () => {
      try {
        const config = await getConfig();
        const client = await createOpenAIClient();
        const { requestId, prefix, suffixContext, pageTitle, pageUrl, pageContent, inputContext } = message;
        const intent: RequestIntent = message.type === "TABHERE_REQUEST_REWRITE" ? "rewrite" : "suggest";
        const selectedText = message.type === "TABHERE_REQUEST_REWRITE" ? message.selectedText : "";
        const developerDebug = Boolean(config.developerDebug);

        if (intent === "rewrite") {
          if (!selectedText || !selectedText.trim()) {
            sendResponse({ type: "TABHERE_SUGGESTION", requestId, suffix: "" });
            return;
          }
        } else {
          if (!prefix || !prefix.trim()) {
            sendResponse({ type: "TABHERE_SUGGESTION", requestId, suffix: "" });
            return;
          }
        }

        if (developerDebug) {
          const inputContextText = formatInputContextText(inputContext);
          console.log("[TabHere debug] request", {
            intent,
            pageTitle: normalizePageTitle(pageTitle),
            pageUrl: normalizePageUrl(pageUrl),
            pageContentLen: normalizePageContent(pageContent).length,
            prefixLen: prefix.length,
            selectedLen: selectedText.length,
            suffixContextLen: String(suffixContext ?? "").length,
            inputContextText: inputContextText || "(empty)"
          });
        }

        const cacheKey = buildSuggestionCacheKey(
          config,
          intent,
          prefix,
          selectedText,
          suffixContext,
          pageTitle,
          pageUrl,
          pageContent,
          inputContext
        );

        if (cacheKey) {
          const cached = getCachedSuggestion(cacheKey);
          if (cached !== null) {
            if (developerDebug) {
              console.log("[TabHere debug] cache hit");
            }
            sendResponse({ type: "TABHERE_SUGGESTION", requestId, suffix: cached });
            return;
          }
        }

        const fetchSuggestion = async (): Promise<string> => {
          const prompt =
            intent === "rewrite"
              ? buildRewritePrompt(prefix, selectedText, suffixContext, pageTitle, pageUrl, pageContent, inputContext, config.userInstructions)
              : buildSuggestionPrompt(prefix, suffixContext, pageTitle, pageUrl, pageContent, inputContext, config.userInstructions);

          if (developerDebug) {
            console.log("[TabHere debug] system prompt\n" + prompt.system);
          }

          let outputText = "";
          try {
            outputText = await requestWithResponses(client, config, prompt);
          } catch (error: any) {
            if (isResponsesUnsupported(error)) {
              outputText = await requestWithChat(client, config, prompt);
            } else {
              throw error;
            }
          }

          const normalized = normalizeModelOutput(outputText, intent, selectedText);

          if (developerDebug) {
            console.log("[TabHere debug] model output\n" + String(outputText || "(empty)"));
            if (normalized !== outputText) {
              console.log("[TabHere debug] normalized output\n" + String(normalized || "(empty)"));
            }
          }

          return normalized;
        };

        let outputText = "";
        if (cacheKey) {
          const inflight = inflightSuggestions.get(cacheKey);
          if (inflight) {
            outputText = await inflight;
          } else {
            const promise = fetchSuggestion()
              .then((text) => {
                setCachedSuggestion(cacheKey, text);
                return text;
              })
              .finally(() => {
                inflightSuggestions.delete(cacheKey);
              });
            inflightSuggestions.set(cacheKey, promise);
            outputText = await promise;
          }
        } else {
          outputText = await fetchSuggestion();
        }
        sendResponse({
          type: "TABHERE_SUGGESTION",
          requestId,
          suffix: outputText
        });
      } catch (error: any) {
        console.error("TabHere OpenAI error", error);
        sendResponse({
          type: "TABHERE_SUGGESTION",
          requestId: (message as any)?.requestId || "",
          suffix: "",
          error: error?.message || "OpenAI error"
        });
      }
    })();

    return true;
  }
);
