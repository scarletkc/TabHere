import OpenAI from "openai";
import { getConfig } from "./shared/config";
import type { SuggestionRequestMessage, SuggestionResponseMessage } from "./shared/types";

type ClientCache = {
  apiKey?: string;
  baseUrl?: string;
  client?: OpenAI;
};

const clientCache: ClientCache = {};

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

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
  const system =
    "You are an intelligent input-method completion engine."
    "Output only the natural continuation suffix of the user’s text."
    "Do not rewrite, repeat, or correct the existing prefix."
    "Do not add explanations. Do not answer questions."
    "Requirements: 1) Do not rewrite the prefix; 2) Do not repeat the prefix; 3) Match the language/tone of the prefix; 4) Keep the length moderate.";
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
