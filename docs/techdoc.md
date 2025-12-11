# TabHere 技术设计文档

> 版本：v0.2（技术方案优化稿）
> 插件名：**TabHere**
> 功能：在网页任意输入框中提供 AI 自动补全（Tab 接受，类似 IDE 补全）
> 适用范围：Chrome 扩展（Manifest V3）

---

## 1. 产品与技术概览

### 1.1 产品目标

TabHere 是一个 Chrome 扩展，提供「全局 AI 输入补全」能力：

* 支持网页上的 **input / textarea / contenteditable** 区域
* 用户输入一部分文字后，TabHere 会调用 OpenAI 模型生成续写建议
* 建议以「灰色幽灵文本」的形式贴在原输入后面
* 用户按下 **Tab** 接受补全，将建议合并到真实输入框里
* **多语言适配**：根据输入语言自动生成匹配语言的补全

非目标与边界（v0.1/v0.2）：

* 不支持密码框、信用卡/安全码等敏感输入框（默认禁用 `type=password` 等）。
* 不保证对所有富文本/虚拟 DOM 编辑器 100% 兼容（见兼容性章节），以“尽可能覆盖常见输入场景”为目标。
* 不对用户输入做云端存储与分析；仅用于实时补全。

### 1.2 技术关键点

* **Manifest V3** Chrome 扩展
* 使用 **content script + background service worker** 架构
* 使用官方 **JavaScript/TypeScript OpenAI SDK**，调用 **Responses API** 生成文本补全
* 用户在扩展设置（options page）中填写自己的 **OpenAI API Key**，保存在浏览器本地 `chrome.storage`（默认 `sync`，可选 `local`）
* 默认推荐模型：`gpt-5.2-mini`（价格低、速度快，适合大量小补全任务）
* **后缀式补全**：模型只返回“补全后缀”，避免改写前缀带来的错配
* **防抖 + 取消/乱序保护**：对输入请求做防抖、对旧请求 `abort` 或丢弃，保证 UI 一致性
* **可配置快捷键与站点开关**：降低 Tab 冲突与隐私风险

---

## 2. 整体架构设计

### 2.1 模块划分

1. **content script（`content.ts` / `content.js`）**

   * 注入到所有网页
   * 监听输入框的 `focus / input / keydown` 事件
   * 组织当前上下文（已输入文本、页面信息等）
   * 通过 `chrome.runtime.sendMessage` 请求后台生成补全
   * 渲染幽灵提示、处理 Tab 接受 / ESC 取消

2. **background service worker（`background.ts` / `background.js`）**

   * 作为扩展的「后端」
   * 监听来自 content script 的消息
   * 从 `chrome.storage` 读取用户配置（API Key、模型 ID 等）
   * 使用 **OpenAI SDK** 调用 `client.responses.create` 生成补全
   * 将补全结果返回 content script

3. **Options 页面（`options.html` + `options.ts`）**

   * 一个简单设置页
   * 用户输入 / 修改：

     * OpenAI API Key
     * BaseURL / Endpoint（可选，默认 `https://api.openai.com/v1`）
     * 模型 ID（默认 `gpt-5.2-mini`）
     * 补全触发延迟、最大补全长度、最低触发字数等参数
     * 快捷键（默认 Tab，可切换 `Ctrl+Space` 等）
     * 站点黑白名单、是否发送 URL/标题、是否同步 Key 等隐私选项
   * 使用 `chrome.storage.sync`（或按用户选择 `local`）持久化这些配置

4. **UI Overlay 模块（content 内部子模块）**

   * 根据当前输入框位置计算 overlay 的坐标和样式
   * 在输入框内渲染幽灵补全文本
   * 响应滚动、窗口 resize 等事件调整位置

### 2.2 数据流

1. 用户在页面输入框中开始输入文字

2. `content script` 监听到 `input` 事件，启动防抖计时器（例如 500ms）

3. 防抖结束后，`content script` 为本次输入生成 `requestId`，并取消上一轮未完成请求（`AbortController` 或逻辑丢弃），然后向 `background` 发送 `TABHERE_REQUEST_SUGGESTION` 消息，携带：

   * 当前输入文本
   * 光标位置 / 选区信息（可选）
   * 输入语言/方向（可选）
   * 页面标题 / URL / 额外上下文（可选，受隐私开关控制）
   * requestId

4. `background`：

   * 从 `chrome.storage` 获取 API Key 和设置
   * 构造 prompt，调用 OpenAI SDK 的 `client.responses.create`
   * 得到补全后缀（suffix），将其连同 requestId 通过 `sendResponse` 返回

5. `content script`：

   * 只接受最新 requestId 的返回，将 suffix 缓存为 `currentSuggestionSuffix`
   * 刷新 overlay，在光标后方显示灰色的「补全后缀」
   * 用户按下 **Tab**：

     * 将 `currentSuggestionSuffix` 追加写回输入框/光标位置
     * 清空 overlay

---

## 3. 项目结构

建议使用一个简单的打包工具（如 Vite / Rollup / Webpack）输出到 `dist/`，结构示意：

```text
tabhere/
├─ src/
│  ├─ background.ts
│  ├─ content.ts
│  ├─ options/
│  │  ├─ options.html
│  │  └─ options.ts
│  └─ ui/
│     └─ overlay.ts
├─ public/
│  └─ icon-128.png
├─ manifest.json
└─ dist/          # 打包输出
```

---

## 4. Manifest 配置

`manifest.json` 示例（MV3）：

```json
{
  "manifest_version": 3,
  "name": "TabHere - AI Autocomplete",
  "version": "0.1.0",
  "description": "在任意网页输入框中使用 OpenAI 进行 Tab 自动补全。",
  "icons": {
    "128": "public/icon-128.png"
  },
  "permissions": [
    "storage"
  ],
  "host_permissions": [
    "https://api.openai.com/*"
  ],
  "optional_host_permissions": [
    "*://*/v1/*"
  ],
  "background": {
    "service_worker": "dist/background.js",
    "type": "module"
  },
  "options_page": "dist/options/options.html",
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["dist/content.js"],
      "run_at": "document_idle"
    }
  ]
}
```

说明：

* `permissions` 最小化为 `storage`；若未来采用运行时动态注入，可再加入 `scripting` / `activeTab`
* `host_permissions` 仅允许默认 OpenAI 域名；若用户启用自定义 BaseURL，则通过 `optional_host_permissions` 动态申请
* `background.type = "module"` 允许使用 ESM + 顶层 `await`
* 所有源码通过构建工具打包到 `dist`，manifest 指向打包后的文件

---

## 5. content script 设计

### 5.1 功能职责

* 识别可编辑元素：

  * `<input type="text|search|email|url|tel">`
  * `<textarea>`
  * 任意 `contenteditable=true` 元素
  * 默认忽略 `type=password`、`autocomplete=one-time-code` 等高敏输入
* 监听事件：

  * `focusin / focusout`：维护当前活跃输入框引用
  * `input`：用户输入内容
  * `compositionstart / compositionend`：兼容 IME 合成输入（合成中不触发补全）
  * `keydown`：

    * Tab 接受补全
    * ESC 取消补全
* 向后台发送补全请求，并接收建议
* 控制 overlay 的渲染与销毁
* 对 iframe / shadow DOM 中的可编辑区域做尽力支持（监听捕获阶段 + 递归扫描）

### 5.2 核心数据结构

```ts
interface TabHereSuggestionRequest {
  type: "TABHERE_REQUEST_SUGGESTION";
  requestId: string;
  prefix: string;           // 光标前文本（必传）
  suffixContext?: string;   // 光标后文本（可选）
  cursorOffset?: number;    // 光标在 prefix 内的位置（可选）
  languageHint?: string;    // 例如 "zh" / "en"（可选）
  url?: string;
  title?: string;
  maxOutputTokens?: number;
}

interface TabHereSuggestionResponse {
  type: "TABHERE_SUGGESTION";
  requestId: string;
  suffix: string; // 仅补全后缀
  error?: string;
}
```

### 5.3 逻辑要点（伪代码）

```ts
let currentInput: HTMLInputElement | HTMLTextAreaElement | HTMLElement | null = null;
let currentSuggestionSuffix = "";
let latestRequestId: string | null = null;
let abortController: AbortController | null = null;
let isComposing = false;

// 创建 overlay 节点
const suggestionOverlay = document.createElement("div");
// 设置一系列样式: position: fixed; pointer-events: none; z-index: 2147483647; color: gray; ...

function isTextInput(el: EventTarget | null): el is HTMLElement {
  // 根据 tagName / type / isContentEditable 判定
}

function getInputText(el: HTMLElement): string {
  return el.isContentEditable ? el.innerText || "" : (el as HTMLInputElement).value || "";
}

function setInputText(el: HTMLElement, text: string) {
  if (el.isContentEditable) el.innerText = text;
  else (el as HTMLInputElement).value = text;
}

function updateOverlayPosition() {
  if (!currentInput || !currentSuggestionSuffix) {
    suggestionOverlay.style.visibility = "hidden";
    return;
  }
  // v0.2：基于 caret 位置渲染（textarea 镜像 / Range.getClientRects）
  // 并复制输入框的 font/line-height/letter-spacing/padding/transform
}

function scheduleSuggest() {
  // 使用 setTimeout 做 500ms 防抖
  // 在计时结束时：
  if (isComposing) return;
  const prefix = getInputText(currentInput!);
  if (prefix.trim().length < minTriggerChars) return;
  const requestId = crypto.randomUUID();
  latestRequestId = requestId;
  abortController?.abort();
  abortController = new AbortController();

  chrome.runtime.sendMessage<TabHereSuggestionRequest>(
    {
      type: "TABHERE_REQUEST_SUGGESTION",
      requestId,
      prefix,
      url: privacySendUrl ? location.href : undefined,
      title: privacySendTitle ? document.title : undefined,
      maxOutputTokens
    },
    (res: TabHereSuggestionResponse) => {
      if (!res || res.error || res.requestId !== latestRequestId) {
        currentSuggestionSuffix = "";
        updateOverlayPosition();
        return;
      }
      currentSuggestionSuffix = res.suffix;
      updateOverlayPosition();
    }
  );
}

// keydown: Tab 接受补全
document.addEventListener("keydown", (e) => {
  if (!currentInput) return;
  if (e.key === "Tab" && currentSuggestionSuffix) {
    e.preventDefault();
    const text = getInputText(currentInput);
    setInputText(currentInput, text + currentSuggestionSuffix);
    currentSuggestionSuffix = "";
    updateOverlayPosition();
  } else if (e.key === "Escape") {
    currentSuggestionSuffix = "";
    updateOverlayPosition();
  }
});
```

> v0.2 起优先采用 caret 定位；简化定位仅作为降级策略。

---

## 6. background（OpenAI SDK 集成）

### 6.1 OpenAI SDK 使用

官方推荐在 JS/TS 中使用 `openai` SDK，通过 `client.responses.create` 调用 Responses API 生成文本。

安装（在项目根目录）：

```bash
npm install openai
```

典型使用方式（Node / 服务端环境）：

```ts
import OpenAI from "openai";

const client = new OpenAI();

const response = await client.responses.create({
  model: "gpt-5.2-mini",
  input: "Write a one-sentence bedtime story about a unicorn."
});

console.log(response.output_text);
```

> TabHere 运行在浏览器扩展的背景脚本中，属于「browser-like」环境。官方 SDK 默认会阻止在浏览器中直接使用，因为这会暴露 API Key，需要用 `dangerouslyAllowBrowser: true` 显式声明你理解风险。
> 在 TabHere 中，Key 是用户自己在本地填写和使用的，不是开发者分发的 Key，因此风险主要在「用户本机被恶意扩展或恶意脚本读取」，需要在文档中明确提醒。

### 6.2 背景脚本核心逻辑（示意）

```ts
// background.ts
import OpenAI from "openai";

async function getUserConfig() {
  return new Promise<{
    apiKey?: string;
    model?: string;
    baseURL?: string;
    maxOutputTokens?: number;
    temperature?: number;
  }>((resolve) => {
    chrome.storage.sync.get(
      [
        "tabhere_api_key",
        "tabhere_model",
        "tabhere_base_url",
        "tabhere_max_output_tokens",
        "tabhere_temperature"
      ],
      (res) => {
        resolve({
          apiKey: res.tabhere_api_key,
          model: res.tabhere_model || "gpt-5.2-mini",
          baseURL: res.tabhere_base_url || "https://api.openai.com/v1",
          maxOutputTokens: res.tabhere_max_output_tokens,
          temperature: res.tabhere_temperature
        });
      }
    );
  });
}

async function createOpenAIClient() {
  const { apiKey, baseURL } = await getUserConfig();
  if (!apiKey) throw new Error("NO_API_KEY");

  const client = new OpenAI({
    apiKey,
    baseURL,
    // 声明我们清楚在浏览器环境中使用的风险
    dangerouslyAllowBrowser: true
  });

  return client;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "TABHERE_REQUEST_SUGGESTION") return;

  (async () => {
    try {
      const client = await createOpenAIClient();
      const { requestId, prefix, suffixContext } = message as {
        requestId: string;
        prefix: string;
        suffixContext?: string;
      };

      if (!prefix || !prefix.trim()) {
        sendResponse({ type: "TABHERE_SUGGESTION", requestId, suffix: "" });
        return;
      }

      const { model, maxOutputTokens, temperature } = await getUserConfig();

      const resp = await client.responses.create({
        model: model || "gpt-5.2-mini",
        max_output_tokens: maxOutputTokens || 64,
        temperature: temperature ?? 0.2,
        input: [
          {
            role: "system",
            content:
              "你是一个智能输入法补全引擎。只输出用户文本的自然续写后缀，不要改写、重复或纠正已有前缀。不要添加解释。"
          },
          {
            role: "user",
            content: [
              "给出接在前缀后的补全后缀。",
              "要求：1) 不改写前缀；2) 不重复前缀；3) 语言/语气与前缀一致；4) 长度适中。",
              `前缀：${prefix}`,
              suffixContext ? `后文上下文（可选）：${suffixContext}` : "",
              "只返回后缀文本："
            ].filter(Boolean).join("\n")
          }
        ]
      });

      const outputText = (resp.output_text || "").trimStart();
      sendResponse({
        type: "TABHERE_SUGGESTION",
        requestId,
        suffix: outputText
      });
    } catch (e: any) {
      console.error("TabHere OpenAI error", e);
      sendResponse({
        type: "TABHERE_SUGGESTION",
        requestId: (message as any)?.requestId || "",
        suffix: "",
        error: e?.message || "OpenAI error"
      });
    }
  })();

  // 表示异步响应
  return true;
});
```

> 说明：
>
> * `resp.output_text` 是 Responses API 的辅助 getter，用于直接取出文本内容。
> * 这里让模型返回「补全后缀」，content script 仅展示后缀，并在 Tab 时追加到真实输入中。

---

## 7. Options 页面与配置管理

### 7.1 UI 要求

Options 页面（`options.html`）包含：

* OpenAI API Key 输入框 + 保存按钮
* 自定义 BaseURL 输入框 Endpoint（可选，默认 `https://api.openai.com/v1`）
* 模型 ID 输入框（默认 `gpt-5.2-mini`）
* 最大补全长度 / max output tokens（可选）
* 补全触发延迟（ms，可选）
* 最低触发字数（避免短输入频繁调用）
* 快捷键设置（默认 Tab；冲突时可改为 `Ctrl+Space` 等）
* 站点黑白名单（域名级）
* 隐私开关：是否发送 URL / 标题；是否同步 API Key；是否在敏感输入禁用

### 7.2 保存与读取

**保存：**

```ts
// options.ts
const apiKeyInput = document.getElementById("apiKey") as HTMLInputElement;
const baseUrlInput = document.getElementById("baseUrl") as HTMLInputElement;
const modelInput = document.getElementById("model") as HTMLInputElement;
const maxOutputTokensInput = document.getElementById("maxOutputTokens") as HTMLInputElement;
const temperatureInput = document.getElementById("temperature") as HTMLInputElement;
const saveBtn = document.getElementById("save") as HTMLButtonElement;

saveBtn.addEventListener("click", () => {
  chrome.storage.sync.set(
    {
      tabhere_api_key: apiKeyInput.value.trim(),
      tabhere_base_url: baseUrlInput.value.trim() || "https://api.openai.com/v1",
      tabhere_model: modelInput.value.trim() || "gpt-5.2-mini",
      tabhere_max_output_tokens: Number(maxOutputTokensInput.value) || 64,
      tabhere_temperature: Number(temperatureInput.value) || 0.2
    },
    () => {
      // 提示已保存
      alert("TabHere 设置已保存");
    }
  );
});

// 初始化时读取
chrome.storage.sync.get(
  [
    "tabhere_api_key",
    "tabhere_base_url",
    "tabhere_model",
    "tabhere_max_output_tokens",
    "tabhere_temperature"
  ],
  (res) => {
    if (res.tabhere_api_key) apiKeyInput.value = res.tabhere_api_key;
    baseUrlInput.value = res.tabhere_base_url || "https://api.openai.com/v1";
    modelInput.value = res.tabhere_model || "gpt-5.2-mini";
    maxOutputTokensInput.value = String(res.tabhere_max_output_tokens || 64);
    temperatureInput.value = String(res.tabhere_temperature ?? 0.2);
  }
);
```

> 注意：以上示例默认使用 `chrome.storage.sync`。若用户关闭“同步 API Key”，则读写应切换到 `chrome.storage.local`（可通过 `tabhere_use_sync` 标志控制）。

> 推荐使用 `sync` 而不是 `local`，这样用户在用同一账号登录 Chrome，同步扩展时也能自动同步设置。
> 若用户更关注安全，可在 Options 中选择将 API Key 存于 `local` 并关闭同步。

---

## 8. 安全与隐私注意事项

1. **API Key 所有权**

   * TabHere 不内置任何 OpenAI Key，所有 Key 均由用户自行创建和填写。
   * 插件使用 Key 调用 OpenAI 的费用全部由用户账户承担。

2. **浏览器环境中的 SDK 使用风险**

   * 官方不推荐在纯浏览器环境暴露 API Key，因为任何能执行 JS 的恶意脚本都有机会窃取它。
   * 在扩展背景脚本中使用时，风险相对较低，但仍需提示用户：

     * 不要在不信任的电脑 / 浏览器上使用个人 Key
     * 建议使用专门为 TabHere 创建、定期轮换的 Key

3. **数据隐私**

   * TabHere 只会把当前输入内容发送给 OpenAI 以生成补全
   * 页面标题 / URL 默认不发送，需用户显式开启
   * 不会上传完整网页内容或其他敏感数据（除非用户输入到了文本框里）
   * 可以在 README / Options 页中加入隐私说明
   * 上架 Chrome Web Store 需符合“最小权限 + 明确披露数据使用”要求

---

## 9. 性能、成本与兼容性策略

### 9.1 性能与成本

* **防抖与最小触发阈值**：默认 400–600ms 防抖，`minTriggerChars` 默认 3–5。
* **请求取消/乱序保护**：新输入触发时取消旧请求；仅渲染最新 requestId 的结果。
* **长度控制**：`max_output_tokens` 默认 32–64，避免长补全带来成本与 UI 侵入。
* **错误与退避**：连续失败时短暂退避（例如 3s），避免刷 API。
* **可选缓存**：对同一前缀的短期重复请求做内存级缓存（tab 生命周期内）。

### 9.2 兼容性与降级

* **优先支持**：原生 `input/textarea`、简单 `contenteditable`。
* **需尽力支持**：shadow DOM/iframe 内输入、常见富文本编辑器（Notion/Slack/Gmail/飞书/语雀等）。
* **已知高风险**：Google Docs、某些虚拟光标编辑器、Canvas/自绘输入、复杂 IME 叠加场景。
* **降级策略**：无法精确定位 caret 时，退回到输入框左上角或关闭 overlay；仍允许 Tab 接受。

---

## 10. 开发、调试与打包流程

1. **安装依赖**

   ```bash
   npm install
   npm install openai
   ```

2. **本地开发**

   * 使用打包工具（如 Vite）构建到 `dist/`
   * 每次修改代码后执行 `npm run build` 生成最新 `dist` 文件

3. **在 Chrome 中加载**

   * 打开 `chrome://extensions/`
   * 打开右上角「开发者模式」
   * 点击「加载已解压的扩展程序」
   * 选择项目根目录（包含 `manifest.json` 的目录）
   * 在任意页面打开 DevTools 观察 `content.js` 和 `background.js` 的日志

4. **常见调试点**

   * `background` 是否成功读取到 API Key
   * 调用 OpenAI 是否 200 成功（在「服务工作线程」的 console / network 查看）
   * content script 是否收到了建议并正确显示 overlay
   * Tab 是否抢占了网页原本的 Tab 行为（有冲突时可考虑换为 `Ctrl+Space` 等快捷键）

---

## 11. 后续扩展方向（规划）

* **站点黑白名单**：在 Options 页配置在哪些域名启用 / 禁用 TabHere
* **更精细的光标跟随**：使用 selection / range 精确计算光标位置
* **模型策略优化**：

  * 短输入时不调用（减少无意义请求）
  * 将「当前输入框前后文本、页面标题、URL」作为 prompt 上下文，提升相关性
* **流式补全（Streaming）**：基于 Responses API 的 SSE 流式能力，将补全逐字显示
