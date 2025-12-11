# TabHere

Chrome 扩展：在任意网页输入框里提供 AI 续写补全，按 Tab（或自定义快捷键）接受。

## 开发 / 构建

1. 安装依赖

```bash
npm install
```

2. 构建到 `dist/`

```bash
npm run build
```

3. 在 Chrome 里加载

- 打开 `chrome://extensions/`，开启“开发者模式”
- 点击“加载已解压的扩展程序”，选择项目根目录（包含 `manifest.json`）
- 每次改动后重新执行 `npm run build`，然后在扩展页点“重新加载”

## 使用

1. 进入扩展的 Options 页面，填写 OpenAI API Key（可选配置 Base URL / 模型等），保存。
2. 在任意网页的文本输入框中输入文字，停顿片刻会出现灰色补全文本。
3. 按 Tab 接受补全；按 Esc 取消。

## 隐私

- Key 由用户自行提供，存储在浏览器 `chrome.storage` 中。
- 仅发送当前输入框中内容用于实时补全。

