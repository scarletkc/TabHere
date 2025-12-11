import { DEFAULT_CONFIG, getConfig, saveConfig } from "../shared/config";
import type { ShortcutKey } from "../shared/types";

const apiKeyInput = document.getElementById("apiKey") as HTMLInputElement;
const baseUrlInput = document.getElementById("baseUrl") as HTMLInputElement;
const modelInput = document.getElementById("model") as HTMLInputElement;
const maxOutputTokensInput = document.getElementById("maxOutputTokens") as HTMLInputElement;
const temperatureInput = document.getElementById("temperature") as HTMLInputElement;
const debounceMsInput = document.getElementById("debounceMs") as HTMLInputElement;
const minTriggerCharsInput = document.getElementById("minTriggerChars") as HTMLInputElement;
const shortcutKeySelect = document.getElementById("shortcutKey") as HTMLSelectElement;
const sendUrlCheckbox = document.getElementById("sendUrl") as HTMLInputElement;
const sendTitleCheckbox = document.getElementById("sendTitle") as HTMLInputElement;
const useSyncCheckbox = document.getElementById("useSync") as HTMLInputElement;
const disableOnSensitiveCheckbox = document.getElementById("disableOnSensitive") as HTMLInputElement;
const enabledSitesTextarea = document.getElementById("enabledSites") as HTMLTextAreaElement;
const disabledSitesTextarea = document.getElementById("disabledSites") as HTMLTextAreaElement;
const saveBtn = document.getElementById("save") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLSpanElement;

function setStatus(message: string, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#c00" : "#0a7";
}

function parseSites(value: string): string[] {
  return value
    .split(/[\n,]/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function ensureOptionalHostPermission(baseUrl: string) {
  const normalized = baseUrl.trim();
  if (!normalized || normalized === DEFAULT_CONFIG.baseUrl) return;

  const optionalOrigin = "*://*/v1/*";
  const alreadyGranted = await new Promise<boolean>((resolve) => {
    chrome.permissions.contains({ origins: [optionalOrigin] }, (result) => resolve(Boolean(result)));
  });
  if (alreadyGranted) return;

  const granted = await new Promise<boolean>((resolve) => {
    chrome.permissions.request({ origins: [optionalOrigin] }, (result) => resolve(Boolean(result)));
  });
  if (!granted) {
    alert("未授权自定义 Base URL 的访问权限，可能导致请求失败。");
  }
}

async function load() {
  const cfg = await getConfig();
  apiKeyInput.value = cfg.apiKey || "";
  baseUrlInput.value = cfg.baseUrl;
  modelInput.value = cfg.model;
  maxOutputTokensInput.value = String(cfg.maxOutputTokens);
  temperatureInput.value = String(cfg.temperature);
  debounceMsInput.value = String(cfg.debounceMs);
  minTriggerCharsInput.value = String(cfg.minTriggerChars);
  shortcutKeySelect.value = cfg.shortcutKey;
  sendUrlCheckbox.checked = cfg.sendUrl;
  sendTitleCheckbox.checked = cfg.sendTitle;
  useSyncCheckbox.checked = cfg.useSync;
  disableOnSensitiveCheckbox.checked = cfg.disableOnSensitive;
  enabledSitesTextarea.value = cfg.enabledSites.join("\n");
  disabledSitesTextarea.value = cfg.disabledSites.join("\n");
}

saveBtn.addEventListener("click", async () => {
  setStatus("");

  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    setStatus("请填写 OpenAI API Key", true);
    return;
  }
  if (!apiKey.startsWith("sk-")) {
    const proceed = confirm("API Key 看起来不正确（应以 sk- 开头）。仍然保存吗？");
    if (!proceed) return;
  }

  const baseUrl = baseUrlInput.value.trim() || DEFAULT_CONFIG.baseUrl;
  try {
    new URL(baseUrl);
  } catch {
    setStatus("Base URL 无效", true);
    return;
  }

  const maxTokensStr = maxOutputTokensInput.value.trim();
  let maxOutputTokens = DEFAULT_CONFIG.maxOutputTokens;
  if (maxTokensStr) {
    const parsed = Number(maxTokensStr);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setStatus("最大补全长度需为正数", true);
      return;
    }
    maxOutputTokens = parsed;
  }

  const tempStr = temperatureInput.value.trim();
  let temperature = DEFAULT_CONFIG.temperature;
  if (tempStr) {
    const parsed = Number(tempStr);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
      setStatus("温度需在 0~2 之间", true);
      return;
    }
    temperature = parsed;
  }

  const debounceStr = debounceMsInput.value.trim();
  let debounceMs = DEFAULT_CONFIG.debounceMs;
  if (debounceStr) {
    const parsed = Number(debounceStr);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setStatus("补全触发延迟需为非负数", true);
      return;
    }
    debounceMs = parsed;
  }

  const minTriggerStr = minTriggerCharsInput.value.trim();
  let minTriggerChars = DEFAULT_CONFIG.minTriggerChars;
  if (minTriggerStr) {
    const parsed = Number(minTriggerStr);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setStatus("最低触发字数需为非负数", true);
      return;
    }
    minTriggerChars = parsed;
  }

  await ensureOptionalHostPermission(baseUrl);

  const partial = {
    apiKey,
    baseUrl,
    model: modelInput.value.trim() || DEFAULT_CONFIG.model,
    maxOutputTokens,
    temperature,
    debounceMs,
    minTriggerChars,
    shortcutKey: shortcutKeySelect.value as ShortcutKey,
    sendUrl: sendUrlCheckbox.checked,
    sendTitle: sendTitleCheckbox.checked,
    useSync: useSyncCheckbox.checked,
    disableOnSensitive: disableOnSensitiveCheckbox.checked,
    enabledSites: parseSites(enabledSitesTextarea.value),
    disabledSites: parseSites(disabledSitesTextarea.value)
  };

  try {
    await saveConfig(partial);
    setStatus("已保存");
    setTimeout(() => setStatus(""), 2000);
  } catch (error) {
    console.error("Failed to save TabHere config", error);
    setStatus("保存失败，请查看控制台", true);
  }
});

load().catch((e) => {
  console.error("Failed to load TabHere config", e);
});
