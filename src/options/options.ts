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
  statusEl.textContent = "";

  const baseUrl = baseUrlInput.value.trim() || DEFAULT_CONFIG.baseUrl;
  await ensureOptionalHostPermission(baseUrl);

  const partial = {
    apiKey: apiKeyInput.value.trim(),
    baseUrl,
    model: modelInput.value.trim() || DEFAULT_CONFIG.model,
    maxOutputTokens: Number(maxOutputTokensInput.value) || DEFAULT_CONFIG.maxOutputTokens,
    temperature: Number(temperatureInput.value) || DEFAULT_CONFIG.temperature,
    debounceMs: Number(debounceMsInput.value) || DEFAULT_CONFIG.debounceMs,
    minTriggerChars: Number(minTriggerCharsInput.value) || DEFAULT_CONFIG.minTriggerChars,
    shortcutKey: shortcutKeySelect.value as ShortcutKey,
    sendUrl: sendUrlCheckbox.checked,
    sendTitle: sendTitleCheckbox.checked,
    useSync: useSyncCheckbox.checked,
    disableOnSensitive: disableOnSensitiveCheckbox.checked,
    enabledSites: parseSites(enabledSitesTextarea.value),
    disabledSites: parseSites(disabledSitesTextarea.value)
  };

  await saveConfig(partial);
  statusEl.textContent = "已保存";
  setTimeout(() => {
    statusEl.textContent = "";
  }, 2000);
});

load().catch((e) => {
  console.error("Failed to load TabHere config", e);
});
