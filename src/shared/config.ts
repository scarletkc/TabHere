import type { TabHereConfig, ShortcutKey } from "./types";

const DEFAULT_CONFIG: TabHereConfig = {
  apiKey: undefined,
  model: "gpt-5.2-mini",
  baseUrl: "https://api.openai.com/v1",
  maxOutputTokens: 64,
  temperature: 0.2,
  debounceMs: 500,
  minTriggerChars: 3,
  shortcutKey: "Tab",
  useSync: true,
  disabledSites: [],
  enabledSites: [],
  disableOnSensitive: true
};

const CONFIG_KEYS = [
  "tabhere_api_key",
  "tabhere_model",
  "tabhere_base_url",
  "tabhere_max_output_tokens",
  "tabhere_temperature",
  "tabhere_debounce_ms",
  "tabhere_min_trigger_chars",
  "tabhere_shortcut_key",
  "tabhere_use_sync",
  "tabhere_disabled_sites",
  "tabhere_enabled_sites",
  "tabhere_disable_on_sensitive"
] as const;

type ConfigStorageShape = {
  tabhere_api_key?: string;
  tabhere_model?: string;
  tabhere_base_url?: string;
  tabhere_max_output_tokens?: number;
  tabhere_temperature?: number;
  tabhere_debounce_ms?: number;
  tabhere_min_trigger_chars?: number;
  tabhere_shortcut_key?: ShortcutKey;
  tabhere_use_sync?: boolean;
  tabhere_disabled_sites?: string[];
  tabhere_enabled_sites?: string[];
  tabhere_disable_on_sensitive?: boolean;
};

function getStorageArea(useSync: boolean) {
  return useSync ? chrome.storage.sync : chrome.storage.local;
}

function storageGet<T>(area: chrome.storage.StorageArea, keys: readonly string[]): Promise<T> {
  return new Promise((resolve) => {
    area.get(keys as any, (res) => resolve(res as T));
  });
}

function storageSet(area: chrome.storage.StorageArea, items: Record<string, any>): Promise<void> {
  return new Promise((resolve) => {
    area.set(items, () => resolve());
  });
}

export async function getConfig(): Promise<TabHereConfig> {
  const useSyncRes = await storageGet<Pick<ConfigStorageShape, "tabhere_use_sync">>(
    chrome.storage.sync,
    ["tabhere_use_sync"]
  );
  const useSync = useSyncRes.tabhere_use_sync ?? DEFAULT_CONFIG.useSync;

  const storage = getStorageArea(useSync);
  const res = await storageGet<ConfigStorageShape>(storage, CONFIG_KEYS);

  return {
    apiKey: res.tabhere_api_key,
    model: res.tabhere_model || DEFAULT_CONFIG.model,
    baseUrl: res.tabhere_base_url || DEFAULT_CONFIG.baseUrl,
    maxOutputTokens: res.tabhere_max_output_tokens ?? DEFAULT_CONFIG.maxOutputTokens,
    temperature: res.tabhere_temperature ?? DEFAULT_CONFIG.temperature,
    debounceMs: res.tabhere_debounce_ms ?? DEFAULT_CONFIG.debounceMs,
    minTriggerChars: res.tabhere_min_trigger_chars ?? DEFAULT_CONFIG.minTriggerChars,
    shortcutKey: res.tabhere_shortcut_key || DEFAULT_CONFIG.shortcutKey,
    useSync,
    disabledSites: res.tabhere_disabled_sites ?? DEFAULT_CONFIG.disabledSites,
    enabledSites: res.tabhere_enabled_sites ?? DEFAULT_CONFIG.enabledSites,
    disableOnSensitive: res.tabhere_disable_on_sensitive ?? DEFAULT_CONFIG.disableOnSensitive
  };
}

export async function saveConfig(partial: Partial<TabHereConfig>): Promise<void> {
  const current = await getConfig();
  const next: TabHereConfig = { ...current, ...partial };

  await storageSet(chrome.storage.sync, { tabhere_use_sync: next.useSync });
  const storage = getStorageArea(next.useSync);

  const toSave: ConfigStorageShape = {
    tabhere_api_key: next.apiKey,
    tabhere_model: next.model,
    tabhere_base_url: next.baseUrl,
    tabhere_max_output_tokens: next.maxOutputTokens,
    tabhere_temperature: next.temperature,
    tabhere_debounce_ms: next.debounceMs,
    tabhere_min_trigger_chars: next.minTriggerChars,
    tabhere_shortcut_key: next.shortcutKey,
    tabhere_disabled_sites: next.disabledSites,
    tabhere_enabled_sites: next.enabledSites,
    tabhere_disable_on_sensitive: next.disableOnSensitive
  };

  await storageSet(storage, toSave as Record<string, any>);
}

export { DEFAULT_CONFIG };
