# History（页面内消息记录）功能设计说明（未实现）

> 本文档描述一种可选的“同一网页/同一输入场景的补全历史（history/messages）”能力：把用户在某个页面上**确认接受**过的补全/改写记录下来，在后续请求中作为额外上下文注入 prompt，以提升风格一致性与连贯性。
>
> 注意：当前项目默认**不推荐**开启此能力（详见“是否推荐”），因此也**未实现**。本文仅作为未来可能的扩展设计参考。

---

## 1. 功能目标

在同一网页（或同一 tab / frame）内，让 AI 在多次补全之间保持：

- 语气/用词/格式一致（例如邮件、PR 描述、工单回复）
- 对同一对话线程或同一段落的延续性更强
- 对用户偏好（长度/标点/换行）更稳定

同时尽量做到：

- 仅记录“用户明确接受”的输出，避免误把模型的随机建议当作真实上下文
- 本地短期保存、严格限长、可随时关闭

---

## 2. 为什么默认不推荐

**用户体验/成本/隐私**三方面会明显变差，尤其是“全站任意输入框”这种扩展形态：

- 成本与延迟：每次请求都要携带 history，会显著增加 token 与响应时间。
- 干扰风险：history 可能让模型“过度模仿”之前内容，导致跑题/啰嗦/重复。
- 隐私面：history 等价于“额外上传更多用户内容”，需要更强的告知与开关；对表单/聊天/内网系统风险更高。

因此更推荐的默认策略是：仅用当前 `prefix/suffixContext/inputContext` 做一次性补全；history 做成**可选项**并且只对特定站点/场景启用。

---

## 3. 适用场景（建议白名单）

更可能带来收益的页面类型：

- 邮件撰写（主题/正文）
- 工单/客服回复
- PR/Issue 描述、代码评审评论
- 长文/文档编辑器（Notion/语雀类）

不建议启用或需要额外谨慎的场景：

- 银行/支付/账号安全/验证码相关页面（应强制禁用）
- 搜索框、短输入（收益低、成本高）
- 任何包含敏感信息的内部系统（需要更严格的权限/策略）

---

## 4. 数据来源：只记录“已接受”的输出

推荐仅记录用户通过快捷键确认插入/替换的内容：

- 补全（suggest）：用户把 `currentSuggestionSuffix` 插入到光标处
- 改写（rewrite）：用户把 `currentSuggestionSuffix` 替换当前选区

对应当前代码位置：

- 接受动作发生在 `src/content.ts` 的 `handleKeydown()` 内（Tab / Ctrl+Space）并调用 `applySuggestion()`。
- 建议在 `applySuggestion()` 成功后发送一条新消息给 background，例如：
  - `TABHERE_LOG_ACCEPTED`
  - payload：`intent`（suggest/rewrite）、`acceptedText`、可选的 `pageTitle`、`inputContext`（若已存在）、以及用于分桶的 pageKey 信息（见下一节）。

---

## 5. pageKey 设计（按“同页”聚合）

需要一个稳定的 key 来把同一页面的多次请求归到一个 history：

推荐优先使用 background 能获得的 sender 信息（不需要 content 额外传）：

- `tabId`：`sender.tab?.id`
- `frameId`：`sender.frameId`
- `url`：`sender.url`（可归一化为 `origin + pathname`，避免 query 过碎）

常见选择：

1) **更“强一致”**：`tabId + frameId`（同一个 tab/frame 视为同一会话）
2) **更“跨刷新稳定”**：`origin + pathname (+ frameId)`（同一路径算同一页）

通常更推荐 1)：对隐私更友好（不跨页面复用），并且符合“会话内短期 history”的直觉。

---

## 6. 存储策略（短期、本地、严格限长）

### 6.1 存哪儿

优先：

- `chrome.storage.session`（MV3 service worker 休眠后仍可恢复，且是 session 级别）

备选：

- background 内存 `Map<pageKey, Entry>`（实现简单但 service worker 休眠可能丢失）

不建议：

- `chrome.storage.local/sync` 长期存储 history（隐私与膨胀风险高）

### 6.2 限制与清理

建议同时设定：

- 最大条数：例如每个 pageKey 仅保留最近 20 条
- 最大字符数：例如每个 pageKey 总计不超过 2000~4000 字符
- TTL：例如 30 分钟无活动自动过期

清理策略：LRU（最近使用优先）+ TTL。

---

## 7. Prompt 注入方式（两种）

### 7.1 作为 system prompt 的一个 `<HISTORY>` 段落

优点：实现简单，跨 `responses`/`chat.completions` 都一致。
缺点：history 与指令混在 system 中，结构化程度稍差。

示意：

- 在 system prompt 中追加：
  - `<HISTORY>`
  - `- [suggest] ...`
  - `- [rewrite] ...`
  - `</HISTORY>`
  - 并要求“仅将 history 当作风格/上下文参考，避免重复粘贴 history”。

### 7.2 作为额外 messages（更像对话记忆）

优点：语义更清晰（assistant/user 历史），更接近“messages记录”。
缺点：需要维护 role 与格式，且不同 API 形态要分别拼接。

示意：

- user / assistant 交替追加：
  - user: “User accepted insertion/rewrite…”
  - assistant: “(the accepted text)”

---

## 8. 与缓存/防抖的关系（必须考虑）

当前项目在 `src/background.ts` 使用了短期缓存（key 包含 prefix/suffix/title/context hash）。

如果引入 history：

- **缓存 key 必须包含 history 的 hash**，否则 history 更新后会命中旧缓存，导致“看起来没变”。
- history 注入后，整体上下文更长，更容易超过现有限制（需要重新评估 `SUGGESTION_CACHE_MAX_CONTEXT_CHARS` 或更严格截断 history）。

---

## 9. UX 建议（强烈建议做成可选）

如果未来实现，建议 UI/默认策略：

- 默认关闭（Off by default）
- 单独开关 + 站点白名单（只对用户明确启用的站点生效）
- 提供“一键清空 history”（当前站点/全部站点）
- 明确告知：开启后将把更多内容作为上下文发送到模型

---

## 10. 实现落点（对应当前仓库代码）

如果要实现，大体改动面：

- `src/shared/types.ts`
  - 增加 `TABHERE_LOG_ACCEPTED` 消息类型与 payload
- `src/content.ts`
  - 在 `handleKeydown()` 接受补全/改写后，向 background 发 log 消息
- `src/background.ts`
  - 维护 `historyStore`（Map 或 storage.session）
  - 在构建 prompt（`buildSuggestionPrompt` / `buildRewritePrompt`）时注入 history
  - 更新 cacheKey 把 history hash 纳入
- `src/options/*`
  - 新增设置项：是否开启 history、最大条数/TTL、站点白名单等

---

## 11. 推荐结论

“messages/history 记录”更适合 **单一应用内的对话产品**（例如站内 chat），而不是“全站输入框补全”这种通用扩展。

如果未来要做，建议：

- 默认关闭 + 站点白名单
- 仅记录“已接受”的内容
- 短期 session 存储 + 严格限长
- 缓存 key 纳入 history hash

