import { DEFAULT_CONFIG, getConfig, saveConfig } from "../shared/config";
import type { ShortcutKey, TestApiRequestMessage, TestApiResponseMessage } from "../shared/types";

function t(key: string, substitutions?: string | string[]) {
  const msg = chrome.i18n.getMessage(key, substitutions);
  return msg || key;
}

function localizePage() {
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (key) {
      el.textContent = t(key);
    }
  });

  document.querySelectorAll<HTMLElement>("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder");
    if (!key) return;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.placeholder = t(key);
    }
  });

  const pageTitle = t("optPageTitle");
  if (pageTitle) {
    document.title = pageTitle;
  }
}

localizePage();

const apiKeyInput = document.getElementById("apiKey") as HTMLInputElement;
const baseUrlInput = document.getElementById("baseUrl") as HTMLInputElement;
const modelInput = document.getElementById("model") as HTMLInputElement;
const maxOutputTokensInput = document.getElementById("maxOutputTokens") as HTMLInputElement;
const temperatureInput = document.getElementById("temperature") as HTMLInputElement;
const userInstructionsTextarea = document.getElementById("userInstructions") as HTMLTextAreaElement;
const debounceMsInput = document.getElementById("debounceMs") as HTMLInputElement;
const minTriggerCharsInput = document.getElementById("minTriggerChars") as HTMLInputElement;
const shortcutKeySelect = document.getElementById("shortcutKey") as HTMLSelectElement;
const useSyncCheckbox = document.getElementById("useSync") as HTMLInputElement;
const disableOnSensitiveCheckbox = document.getElementById("disableOnSensitive") as HTMLInputElement;
const developerDebugCheckbox = document.getElementById("developerDebug") as HTMLInputElement;
const enabledSitesTextarea = document.getElementById("enabledSites") as HTMLTextAreaElement;
const disabledSitesTextarea = document.getElementById("disabledSites") as HTMLTextAreaElement;
const saveBtn = document.getElementById("save") as HTMLButtonElement;
const testApiBtn = document.getElementById("testApi") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLSpanElement;
const versionEl = document.getElementById("version") as HTMLDivElement | null;

if (versionEl) {
  const manifest = chrome.runtime.getManifest();
  versionEl.textContent = `${t("versionPrefix")}: ${manifest.version}`;
}

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
    alert(t("warningOptionalPermissionDenied"));
  }
}

async function load() {
  const cfg = await getConfig();
  apiKeyInput.value = cfg.apiKey || "";
  baseUrlInput.value = cfg.baseUrl;
  modelInput.value = cfg.model;
  maxOutputTokensInput.value = String(cfg.maxOutputTokens);
  temperatureInput.value = String(cfg.temperature);
  userInstructionsTextarea.value = cfg.userInstructions || "";
  debounceMsInput.value = String(cfg.debounceMs);
  minTriggerCharsInput.value = String(cfg.minTriggerChars);
  shortcutKeySelect.value = cfg.shortcutKey;
  useSyncCheckbox.checked = cfg.useSync;
  disableOnSensitiveCheckbox.checked = cfg.disableOnSensitive;
  developerDebugCheckbox.checked = cfg.developerDebug;
  enabledSitesTextarea.value = cfg.enabledSites.join("\n");
  disabledSitesTextarea.value = cfg.disabledSites.join("\n");
}

saveBtn.addEventListener("click", async () => {
  setStatus("");

  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    setStatus(t("errorApiKeyEmpty"), true);
    return;
  }
  if (!apiKey.startsWith("sk-")) {
    const proceed = confirm(t("confirmApiKeyInvalid"));
    if (!proceed) return;
  }

  const baseUrl = baseUrlInput.value.trim() || DEFAULT_CONFIG.baseUrl;
  try {
    new URL(baseUrl);
  } catch {
    setStatus(t("errorBaseUrlInvalid"), true);
    return;
  }

  const maxTokensStr = maxOutputTokensInput.value.trim();
  let maxOutputTokens = DEFAULT_CONFIG.maxOutputTokens;
  if (maxTokensStr) {
    const parsed = Number(maxTokensStr);
    if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
      setStatus(t("errorMaxTokensInvalid"), true);
      return;
    }
    maxOutputTokens = parsed;
  }

  const tempStr = temperatureInput.value.trim();
  let temperature = DEFAULT_CONFIG.temperature;
  if (tempStr) {
    const parsed = Number(tempStr);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
      setStatus(t("errorTemperatureInvalid"), true);
      return;
    }
    temperature = parsed;
  }

  const userInstructionsRaw = userInstructionsTextarea.value;
  const userInstructions = userInstructionsRaw.trim();
  if (userInstructions.length > 1000) {
    setStatus(t("errorUserInstructionsTooLong", "1000"), true);
    return;
  }

  const debounceStr = debounceMsInput.value.trim();
  let debounceMs = DEFAULT_CONFIG.debounceMs;
  if (debounceStr) {
    const parsed = Number(debounceStr);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setStatus(t("errorDebounceInvalid"), true);
      return;
    }
    debounceMs = parsed;
  }

  const minTriggerStr = minTriggerCharsInput.value.trim();
  let minTriggerChars = DEFAULT_CONFIG.minTriggerChars;
  if (minTriggerStr) {
    const parsed = Number(minTriggerStr);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setStatus(t("errorMinTriggerInvalid"), true);
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
    userInstructions,
    debounceMs,
    minTriggerChars,
    shortcutKey: shortcutKeySelect.value as ShortcutKey,
    useSync: useSyncCheckbox.checked,
    disableOnSensitive: disableOnSensitiveCheckbox.checked,
    developerDebug: developerDebugCheckbox.checked,
    enabledSites: parseSites(enabledSitesTextarea.value),
    disabledSites: parseSites(disabledSitesTextarea.value)
  };

  try {
    await saveConfig(partial);
    setStatus(t("statusSaved"));
    setTimeout(() => setStatus(""), 2000);
  } catch (error) {
    console.error("Failed to save TabHere config", error);
    setStatus(t("errorSaveFailed"), true);
  }
});

load().catch((e) => {
  console.error("Failed to load TabHere config", e);
});

testApiBtn.addEventListener("click", async () => {
  setStatus("");
  testApiBtn.disabled = true;

  try {
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
      setStatus(t("errorApiKeyEmpty"), true);
      return;
    }
    if (!apiKey.startsWith("sk-")) {
      const proceed = confirm(t("confirmApiKeyInvalid"));
      if (!proceed) return;
    }

    const baseUrl = baseUrlInput.value.trim() || DEFAULT_CONFIG.baseUrl;
    try {
      new URL(baseUrl);
    } catch {
      setStatus(t("errorBaseUrlInvalid"), true);
      return;
    }

    const model = modelInput.value.trim() || DEFAULT_CONFIG.model;

    await ensureOptionalHostPermission(baseUrl);

    setStatus(t("statusApiTesting"));

    const message: TestApiRequestMessage = {
      type: "TABHERE_TEST_API",
      apiKey,
      baseUrl,
      model
    };

    const res = await new Promise<TestApiResponseMessage>((resolve) => {
      chrome.runtime.sendMessage(message, (response: TestApiResponseMessage) => {
        const err = chrome.runtime.lastError;
        if (err) {
          resolve({ type: "TABHERE_TEST_API_RESULT", ok: false, message: err.message || "Unknown error" });
          return;
        }
        resolve(response);
      });
    });

    if (res?.type !== "TABHERE_TEST_API_RESULT") {
      setStatus(t("statusApiTestFailed", "Unexpected response"), true);
      return;
    }

    if (res.ok) {
      setStatus(t("statusApiTestOk"));
      setTimeout(() => setStatus(""), 4000);
      return;
    }

    setStatus(t("statusApiTestFailed", res.message || "Unknown error"), true);
  } catch (error: any) {
    console.error("API test failed", error);
    setStatus(t("statusApiTestFailed", error?.message || "Unknown error"), true);
  } finally {
    testApiBtn.disabled = false;
  }
});
