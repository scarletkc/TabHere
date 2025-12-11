import OpenAI from "openai";
import { getConfig } from "./shared/config";
import type { SuggestionRequestMessage, SuggestionResponseMessage } from "./shared/types";

type ClientCache = {
  apiKey?: string;
  baseUrl?: string;
  client?: OpenAI;
};

const clientCache: ClientCache = {};

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
    "你是一个智能输入法补全引擎。只输出用户文本的自然续写后缀，不要改写、重复或纠正已有前缀。不要添加解释。";
  const user = [
    "给出接在前缀后的补全后缀。",
    "要求：1) 不改写前缀；2) 不重复前缀；3) 语言/语气与前缀一致；4) 长度适中。",
    `前缀：${prefix}`,
    suffixContext ? `后文上下文（可选）：${suffixContext}` : "",
    "只返回后缀文本："
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
