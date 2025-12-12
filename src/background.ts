import OpenAI from "openai";
import { getConfig } from "./shared/config";
import type { InputContext, SuggestionRequestMessage, SuggestionResponseMessage } from "./shared/types";

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

function buildSuggestionCacheKey(
  config: Awaited<ReturnType<typeof getConfig>>,
  prefix: string,
  suffixContext?: string,
  pageTitle?: string
): string | null {
  const suffix = suffixContext ?? "";
  const title = normalizePageTitle(pageTitle);
  if (prefix.length + suffix.length + title.length > SUGGESTION_CACHE_MAX_CONTEXT_CHARS) {
    return null;
  }

  return JSON.stringify({
    v: 1,
    baseUrl: config.baseUrl,
    model: config.model,
    temperature: config.temperature,
    maxOutputTokens: config.maxOutputTokens,
    titleLen: title.length,
    titleHash: fnv1a64Hex(title),
    prefixLen: prefix.length,
    prefixHash: fnv1a64Hex(prefix),
    suffixLen: suffix.length,
    suffixHash: fnv1a64Hex(suffix)
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

/**
 * 将 InputContext 格式化为提示词中的上下文描述
 */
function formatInputContext(inputContext?: InputContext): string {
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

function buildPrompt(prefix: string, suffixContext?: string, pageTitle?: string, inputContext?: InputContext) {
  const inputContextText = formatInputContext(inputContext);
  const title = normalizePageTitle(pageTitle);
  const suffix = suffixContext ?? "";
  
  const inputContextSection = inputContextText
    ? `
Additionally, you are given context about the input field:
<INPUT-CONTEXT>
${inputContextText}
</INPUT-CONTEXT>
Use this context to understand what kind of content the user is entering (e.g., email subject, recipient name, message body, search query, etc.) and provide more relevant completions.
`
    : "";

  const system = `You are an intelligent input-method completion engine.

[LANGUAGE]: Auto
[PAGE-TITLE]: ${title}

You will receive the text before and after the cursor (<PREFIX> and <SUFFIX>).
Your task: output ONLY the text that should be inserted at <CURSOR> so that
<PREFIX> + your output + <SUFFIX> is coherent and natural.

Strict requirements:
- Output only the insertion text. No explanations, no tags, no quotes, no Markdown fences.
- Do not repeat or rewrite any part of <PREFIX> or <SUFFIX>.
- Do not answer questions or add commentary.
- Match the surrounding language, style, punctuation, and formatting (including newlines).
- Keep the insertion moderately short unless the context clearly requires longer.
- It conforms to the language of [LANGUAGE] and the context of [PAGE-TITLE].
${inputContextSection}`;

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

function isResponsesUnsupported(error: any): boolean {
  const status = error?.status ?? error?.response?.status;
  if (status === 404 || status === 405) return true;
  const message = String(error?.message || "").toLowerCase();
  return message.includes("not found") && message.includes("404");
}

async function requestSuggestionWithResponses(
  client: OpenAI,
  config: Awaited<ReturnType<typeof getConfig>>,
  prefix: string,
  suffixContext?: string,
  pageTitle?: string,
  inputContext?: InputContext
): Promise<string> {
  const { system, user } = buildPrompt(prefix, suffixContext, pageTitle, inputContext);
  const resp = await client.responses.create({
    model: config.model,
    max_output_tokens: config.maxOutputTokens,
    temperature: config.temperature,
    input: [
      {
        role: "system",
        content: system
      },
      {
        role: "user",
        content: user
      }
    ]
  });

  return extractOutputText(resp).trimStart();
}

async function requestSuggestionWithChat(
  client: OpenAI,
  config: Awaited<ReturnType<typeof getConfig>>,
  prefix: string,
  suffixContext?: string,
  pageTitle?: string,
  inputContext?: InputContext
): Promise<string> {
  const { system, user } = buildPrompt(prefix, suffixContext, pageTitle, inputContext);
  const resp = await client.chat.completions.create({
    model: config.model,
    temperature: config.temperature,
    max_tokens: config.maxOutputTokens,
    messages: [
      {
        role: "system",
        content: system
      },
      {
        role: "user",
        content: user
      }
    ]
  });

  const text = resp?.choices?.[0]?.message?.content ?? "";
  return String(text).trimStart();
}

chrome.runtime.onMessage.addListener(
  (message: SuggestionRequestMessage, _sender, sendResponse: (res: SuggestionResponseMessage) => void) => {
    if (message?.type !== "TABHERE_REQUEST_SUGGESTION") {
      return;
    }

    (async () => {
      try {
        const config = await getConfig();
        const client = await createOpenAIClient();
        const { requestId, prefix, suffixContext, pageTitle, inputContext } = message;

        if (!prefix || !prefix.trim()) {
          sendResponse({ type: "TABHERE_SUGGESTION", requestId, suffix: "" });
          return;
        }

        const cacheKey = buildSuggestionCacheKey(config, prefix, suffixContext, pageTitle);

        if (cacheKey) {
          const cached = getCachedSuggestion(cacheKey);
          if (cached !== null) {
            sendResponse({ type: "TABHERE_SUGGESTION", requestId, suffix: cached });
            return;
          }
        }

        const fetchSuggestion = async (): Promise<string> => {
          let outputText = "";
          try {
            outputText = await requestSuggestionWithResponses(client, config, prefix, suffixContext, pageTitle, inputContext);
          } catch (error: any) {
            if (isResponsesUnsupported(error)) {
              outputText = await requestSuggestionWithChat(client, config, prefix, suffixContext, pageTitle, inputContext);
            } else {
              throw error;
            }
          }
          return outputText;
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
