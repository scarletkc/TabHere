# Privacy Policy for TabHere

Effective date: 2025-12-18

TabHere is a Chrome extension that provides AI-powered autocomplete and rewrite suggestions in editable fields on web pages. This policy explains what data TabHere processes, how it is used, and where it goes.

## Summary

- TabHere does not operate any developer-controlled servers and does not include analytics/telemetry.
- When you trigger a suggestion, TabHere sends prompt data to the AI API endpoint you configured (OpenAI by default) using your API key.
- Extension settings (including your API key) are stored in Chrome extension storage (local or synced, depending on your choice).

## Data TabHere processes

### Content you type or select

When generating a suggestion, TabHere processes text from the current editable field, including:

- Text before the cursor and (optionally) after the cursor in the current field.
- Selected text if you use the rewrite behavior.

### Page and input-field context

To improve suggestion relevance, TabHere may also include:

- Page title.
- Page URL (with username/password removed, and without query parameters or fragments).
- A short snippet of visible text from the current page (up to ~1000 characters), excluding the current input element.
- Input-field metadata such as label text, placeholder, aria-label/description, field name/id, nearby headings, and nearby helper text.

### Settings stored locally (or synced)

TabHere stores your configuration in Chrome extension storage, including:

- API key, base URL, model ID, max output tokens, temperature, trigger delay, minimum trigger characters, shortcut key.
- Allowed/blocked site lists.
- “Disable on sensitive inputs” setting.
- “Developer debug mode” setting.
- Optional personalization text you enter in settings (this is included in the system prompt and sent to your configured AI provider).

### Debug logs (local only)

If “Developer debug mode” is enabled, TabHere writes request/response details and prompt text to the browser console. These logs are not transmitted to the TabHere developer, but they may contain sensitive information because they reflect the text you typed and page context.

## How TabHere uses the data

- To generate autocomplete/rewrite suggestions and display them in the page.
- To test your API settings when you click “Test API”.

## Where the data is sent

- TabHere sends prompt data directly from your browser to the AI API endpoint you configure (default: `https://api.openai.com/v1`).
- If you configure an OpenAI-compatible third-party endpoint, your data will be sent to that provider. Their privacy and data retention policies apply.

TabHere does not send your data to any servers controlled by the TabHere developer.

## Storage and retention

- Extension settings are stored in `chrome.storage.local` or `chrome.storage.sync` depending on your “Sync settings & API key” option. When sync is enabled, Google/Chrome may synchronize these settings across your signed-in browsers.
- TabHere keeps a short-lived in-memory cache of recent suggestions (about 30 seconds) to reduce duplicate requests. This cache is not written to disk.
- TabHere does not implement a server-side history, account system, or centralized database.

## Your choices and controls

- You can restrict where TabHere runs using “Allowed sites” and “Blocked sites”.
- “Disable on sensitive inputs (password/OTP)” is enabled by default; you can change it in settings.
- You can remove your data by clearing the extension’s storage (Chrome → Extensions → TabHere) or by uninstalling the extension.

## Security

- Your API key and settings are stored in Chrome extension storage. Protect your Chrome profile and device to prevent unauthorized access.
- Network requests to the AI provider are made over HTTPS.

## Children’s privacy

TabHere is not directed to children and is intended for general productivity use.

## Changes to this policy

We may update this policy as the extension changes. The latest version will be published alongside the project.

## Contact

If you have questions or requests about this policy, please open an issue at:

https://github.com/scarletkc/TabHere/issues

