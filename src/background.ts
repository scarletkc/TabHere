import OpenAI from "openai";
import { getConfig } from "./shared/config";
import type { SuggestionRequestMessage, SuggestionResponseMessage } from "./shared/types";

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

function buildSuggestionCacheKey(
  config: Awaited<ReturnType<typeof getConfig>>,
  prefix: string,
  suffixContext?: string
): string | null {
  const suffix = suffixContext ?? "";
  if (prefix.length + suffix.length > SUGGESTION_CACHE_MAX_CONTEXT_CHARS) {
    return null;
  }

  return JSON.stringify({
    v: 1,
    baseUrl: config.baseUrl,
    model: config.model,
    temperature: config.temperature,
    maxOutputTokens: config.maxOutputTokens,
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

function buildPrompt(prefix: string, suffixContext?: string) {
  const system = `
You are an intelligent input-method completion engine.
Given a user’s text prefix, output only a natural continuation suffix.
Do not modify, correct, or repeat the prefix.
Do not answer questions or add explanations.
Match the language, style, and tone of the prefix.
Keep the completion moderately short.
`;
  const user = [
    "Provide the completion suffix that follows the given prefix.",
    `Prefix: ${prefix}`,
    suffixContext ? `Subsequent context: ${suffixContext}` : "",
    "Return only the suffix text:"
  ]
    .filter(Boolean)
    .join("\n");
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
  suffixContext?: string
): Promise<string> {
  const { system, user } = buildPrompt(prefix, suffixContext);
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
  suffixContext?: string
): Promise<string> {
  const { system, user } = buildPrompt(prefix, suffixContext);
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
        const { requestId, prefix, suffixContext } = message;

        if (!prefix || !prefix.trim()) {
          sendResponse({ type: "TABHERE_SUGGESTION", requestId, suffix: "" });
          return;
        }

        const cacheKey = buildSuggestionCacheKey(config, prefix, suffixContext);

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
            outputText = await requestSuggestionWithResponses(client, config, prefix, suffixContext);
          } catch (error: any) {
            if (isResponsesUnsupported(error)) {
              outputText = await requestSuggestionWithChat(client, config, prefix, suffixContext);
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
