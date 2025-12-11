# TabHere 技术设计文档

> 版本：v0.1
> 插件名：**TabHere**
> 功能：在网页任意输入框中提供 AI 自动补全（Tab 接受，类似 IDE 补全）

---

## 1. 产品与技术概览

### 1.1 产品目标

TabHere 是一个 Chrome 扩展，提供「全局 AI 输入补全」能力：

* 支持网页上的 **input / textarea / contenteditable** 区域
* 用户输入一部分文字后，TabHere 会调用 OpenAI 模型生成续写建议
* 建议以「灰色幽灵文本」的形式贴在原输入后面
* 用户按下 **Tab** 接受补全，将建议合并到真实输入框里
* **多语言适配**：根据输入语言自动生成匹配语言的补全

### 1.2 技术关键点

* **Manifest V3** Chrome 扩展
* 使用 **content script + background service worker** 架构
* 使用官方 **JavaScript/TypeScript OpenAI SDK**，调用 **Responses API** 生成文本补全
* 用户在扩展的设置（options page）中填写自己的 **OpenAI API Key**，保存在浏览器本地 `chrome.storage` 中
* 默认推荐模型：`gpt-5.2-mini`（价格低、速度快，适合大量小补全任务）

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
     * 模型 ID（默认 `gpt-5.2-mini`）
     * 补全触发延迟、最大补全长度等参数
   * 使用 `chrome.storage.sync` 持久化这些配置

4. **UI Overlay 模块（content 内部子模块）**

   * 根据当前输入框位置计算 overlay 的坐标和样式
   * 在输入框内渲染幽灵补全文本
   * 响应滚动、窗口 resize 等事件调整位置

### 2.2 数据流

1. 用户在页面输入框中开始输入文字

2. `content script` 监听到 `input` 事件，启动防抖计时器（例如 500ms）

3. 防抖结束后，`content script` 向 `background` 发送 `REQUEST_SUGGESTION` 消息，携带：

   * 当前输入文本
   * 光标位置（可选）
   * 页面标题 / URL / 额外上下文（可选）

4. `background`：

   * 从 `chrome.storage` 获取 API Key 和设置
   * 构造 prompt，调用 OpenAI SDK 的 `client.responses.create`
   * 得到完整补全文本，将其通过 `sendResponse` 返回

5. `content script`：

   * 接收返回的建议，将其缓存为 `currentSuggestion`
   * 刷新 overlay，在输入框后方显示灰色的「剩余部分」
   * 用户按下 **Tab**：

     * 将 `currentSuggestion` 写回输入框
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
    "storage",
    "scripting",
    "activeTab"
  ],
  "host_permissions": [
    "https://api.openai.com/*"
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

* `host_permissions` 只需要 `https://api.openai.com/*` 即可调用 OpenAI API
* `background.type = "module"` 允许使用 ESM + 顶层 `await`
* 所有源码通过构建工具打包到 `dist`，manifest 指向打包后的文件

---

## 5. content script 设计

### 5.1 功能职责

* 识别可编辑元素：

  * `<input type="text|search|email|url|tel">`
  * `<textarea>`
  * 任意 `contenteditable=true` 元素
* 监听事件：

  * `focusin / focusout`：维护当前活跃输入框引用
  * `input`：用户输入内容
  * `keydown`：

    * Tab 接受补全
    * ESC 取消补全
* 向后台发送补全请求，并接收建议
* 控制 overlay 的渲染与销毁

### 5.2 核心数据结构

```ts
interface TabHereSuggestionRequest {
  type: "TABHERE_REQUEST_SUGGESTION";
  text: string;
  url: string;
  title: string;
  maxTokens?: number;
}

interface TabHereSuggestionResponse {
  type: "TABHERE_SUGGESTION";
  suggestion: string; // 完整结果（包含原文本 + 补全）
  error?: string;
}
```

### 5.3 逻辑要点（伪代码）

```ts
let currentInput: HTMLInputElement | HTMLTextAreaElement | HTMLElement | null = null;
let currentSuggestion = "";

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
  if (!currentInput || !currentSuggestion) {
    suggestionOverlay.style.visibility = "hidden";
    return;
  }
  const rect = currentInput.getBoundingClientRect();
  // 简化版：overlay 放在输入框左上角，字体与输入框同步
  // 实际可根据光标位置进一步计算
}

function scheduleSuggest() {
  // 使用 setTimeout 做 500ms 防抖
  // 在计时结束时：
  const text = getInputText(currentInput!);
  chrome.runtime.sendMessage<TabHereSuggestionRequest>(
    {
      type: "TABHERE_REQUEST_SUGGESTION",
      text,
      url: location.href,
      title: document.title
    },
    (res: TabHereSuggestionResponse) => {
      if (!res || res.error) {
        currentSuggestion = "";
        updateOverlayPosition();
        return;
      }
      currentSuggestion = res.suggestion;
      updateOverlayPosition();
    }
  );
}

// keydown: Tab 接受补全
document.addEventListener("keydown", (e) => {
  if (!currentInput) return;
  if (e.key === "Tab" && currentSuggestion) {
    e.preventDefault();
    const text = getInputText(currentInput);
    if (currentSuggestion.startsWith(text)) {
      setInputText(currentInput, currentSuggestion);
    }
    currentSuggestion = "";
    updateOverlayPosition();
  } else if (e.key === "Escape") {
    currentSuggestion = "";
    updateOverlayPosition();
  }
});
```

> 在后续优化中，可以用 `Range.getClientRects()` 精确计算光标位置，让幽灵文本紧贴光标，而不是简单放在输入框角落。

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
  return new Promise<{ apiKey?: string; model?: string }>((resolve) => {
    chrome.storage.sync.get(
      ["tabhere_api_key", "tabhere_model"],
      (res) => {
        resolve({
          apiKey: res.tabhere_api_key,
          model: res.tabhere_model || "gpt-5.2-mini"
        });
      }
    );
  });
}

async function createOpenAIClient() {
  const { apiKey } = await getUserConfig();
  if (!apiKey) throw new Error("NO_API_KEY");

  const client = new OpenAI({
    apiKey,
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
      const { text } = message as { text: string };

      if (!text || !text.trim()) {
        sendResponse({ type: "TABHERE_SUGGESTION", suggestion: "" });
        return;
      }

      const { model } = await getUserConfig();

      const resp = await client.responses.create({
        model: model || "gpt-5.2-mini",
        input: [
          {
            role: "system",
            content:
              "你是一个智能输入法，只负责在用户已经输入的文本后继续自然补全，不要重新改写已有内容。"
          },
          {
            role: "user",
            content: `请在这段文本后继续合理的补全，只返回补全后的完整文本：\n${text}`
          }
        ]
      });

      const outputText = resp.output_text || "";
      sendResponse({
        type: "TABHERE_SUGGESTION",
        suggestion: outputText
      });
    } catch (e: any) {
      console.error("TabHere OpenAI error", e);
      sendResponse({
        type: "TABHERE_SUGGESTION",
        suggestion: "",
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
> * 这里让模型返回「完整文本」（原文本 + 补全），在 content script 里只显示「多出来的部分」。

---

## 7. Options 页面与配置管理

### 7.1 UI 要求

Options 页面（`options.html`）包含：

* OpenAI API Key 输入框 + 保存按钮
* 自定义baseURL输入框 Endpoint （可选，默认 `https://api.openai.com/v1`）
* 模型 ID 输入框（默认 `gpt-5.2-mini`）
* 最大补全长度（可选）
* 补全触发延迟（ms，可选）

### 7.2 保存与读取

**保存：**

```ts
// options.ts
const apiKeyInput = document.getElementById("apiKey") as HTMLInputElement;
const modelInput = document.getElementById("model") as HTMLInputElement;
const saveBtn = document.getElementById("save") as HTMLButtonElement;

saveBtn.addEventListener("click", () => {
  chrome.storage.sync.set(
    {
      tabhere_api_key: apiKeyInput.value.trim(),
      tabhere_model: modelInput.value.trim() || "gpt-5.2-mini"
    },
    () => {
      // 提示已保存
      alert("TabHere 设置已保存");
    }
  );
});

// 初始化时读取
chrome.storage.sync.get(
  ["tabhere_api_key", "tabhere_model"],
  (res) => {
    if (res.tabhere_api_key) apiKeyInput.value = res.tabhere_api_key;
    modelInput.value = res.tabhere_model || "gpt-5.2-mini";
  }
);
```

> 推荐使用 `sync` 而不是 `local`，这样用户在用同一账号登录 Chrome，同步扩展时也能自动同步设置。

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

   * TabHere 只会把当前输入内容、页面标题 / URL（可选）发送给 OpenAI 以生成补全
   * 不会上传完整网页内容或其他敏感数据（除非用户输入到了文本框里）
   * 可以在 README / Options 页中加入隐私说明

---

## 9. 开发、调试与打包流程

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

## 10. 后续扩展方向（规划）

* **站点黑白名单**：在 Options 页配置在哪些域名启用 / 禁用 TabHere
* **更精细的光标跟随**：使用 selection / range 精确计算光标位置
* **模型策略优化**：

  * 短输入时不调用（减少无意义请求）
  * 将「当前输入框前后文本、页面标题、URL」作为 prompt 上下文，提升相关性
* **流式补全（Streaming）**：基于 Responses API 的 SSE 流式能力，将补全逐字显示