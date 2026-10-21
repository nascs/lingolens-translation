# LingoLens

A local-first Chrome extension for immersive bilingual reading. LingoLens keeps the original page and inserts an AI translation after each readable block. It works with OpenAI, DeepSeek, and any OpenAI-compatible endpoint you configure, using your own API key.

## Features

- **In-page bilingual translation** — translates readable blocks as you scroll; supports pause, resume, dynamic content, and one-click restore.
- **Layout-aware insert placement** — picks a safer insertion point so translations avoid landing inside links, clipped containers, or flex/grid children.
- **Three display modes** — bilingual (original + translation), translation-only, or hover (translation appears when you move the pointer over the original). The choice is remembered.
- **Quick text translation in the popup** — paste text, pick a target language (or keep smart detection), press `Ctrl+Enter`, and copy the result without opening a separate page.
- **Quick window for text and screenshots** — a real browser window with text and image tabs, used when the toolbar popup cannot reach your IME or when translating a screenshot.
- **Image translation** — paste, drop, or choose a screenshot; a vision model transcribes the text and translates it. Images are downscaled to 1600 px on the long edge before upload.
- **Standalone translator page** — long-form text with smart language selection (Chinese → English, everything else → Simplified Chinese) or a manual target language.
- **Glossary** — define fixed term mappings (`source=target`, one per line) that apply to page, popup, and PDF translation. Up to 100 entries.
- **Markdown export** — export the current page's source/translation pairs from the popup for archiving or sharing.
- **Persistent translation cache** — results survive service-worker restarts and browser restarts, so identical content is not billed twice.
- **PDF dual-pane translation** — original canvas on the left, same-size translation canvas on the right, shared scrolling. Images from the original page are copied in place, headings keep their hierarchy, centered paragraphs stay centered, and text is anchored to the original vertical position when reliable geometry is available.
- **Selection bubble and context menu** — translate selected text without leaving the page.
- **Providers and safety** — DeepSeek, OpenAI, and custom OpenAI-compatible endpoints with per-origin permission requests, connection testing, and explicit consent for remote HTTP.
- **Progressive loading** — viewport-first small batches, up to four concurrent requests, session cache, and exponential backoff for 429/5xx responses.
- **Keyboard shortcut** — `Alt+Shift+T` translates or restores the current page.

## Requirements

- Node.js 22 or newer (for building and packaging)
- Chrome 115 or newer

## Build and install

```bash
npm ci
npm run check        # typecheck + unit tests + build + dist validation
```

1. Open `chrome://extensions/`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this project's `dist/` directory.
4. Open the extension settings. The default provider is **Custom** with empty address, model, and API key — fill in your own OpenAI-compatible endpoint. The API key is stored only in `chrome.storage.local`.
5. Remote HTTP endpoints additionally require checking the plaintext-risk consent box; otherwise saving, testing, permission requests, and translation are refused. HTTPS and `localhost` / `127.0.0.1` HTTP do not require it.
6. Visit a regular web page and click the LingoLens toolbar icon. A floating panel appears for translating, pausing, or restoring.

> Chrome internal pages and the Chrome Web Store block script injection, so they cannot be translated.

## Text and image input

### CJK input in the toolbar popup

On Wayland (KDE or GNOME with fcitx5/IBus), Chrome does not deliver IME composition events to toolbar popups. Latin characters and pasted text work, but typing Chinese, Japanese, or Korean does not. This is a Chromium bug (issues 452830034 and 572154970), not an extension bug, and it does not affect X11.

Click **新窗口输入** in the popup to open `quick.html` as a normal browser window, where the IME works. The window has a **文本** tab and an **图片** tab and can stay open next to the page you are reading.

### Image translation

- Paste a screenshot with `Ctrl+V`, drag it into the window, or choose a file. PNG, JPEG, and WebP up to 25 MB are accepted.
- Images longer than 1600 px on the long edge are downscaled; large PNGs are re-encoded as JPEG before upload.
- Set **图片模型** in settings to a vision-capable model such as `gpt-4o-mini`, `gemini-2.0-flash`, or `qwen-vl-max`. Leave it empty to reuse the text model, which only works if that model accepts image input.
- The result shows the recognised source text and the translation. If the provider rejects image input, LingoLens names the configured model and links to settings instead of failing silently.
- Screenshots are sent only when you click **翻译图片** and are not cached or stored.

## Packaging

```bash
npm run package      # builds dist/ and writes lingolens-extension.zip
```

The archive contains the contents of `dist/` at its root (`manifest.json` at the top level), so it can be uploaded to the Chrome Web Store or unpacked for sideloading. Entries are sorted, timestamps are fixed, and compression is deterministic, which makes repeated builds byte-identical. The script prints the archive size and SHA-256 checksum.

To run every gate and then package:

```bash
npm run release      # check + package
```

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main`, every pull request, and on manual dispatch. It installs dependencies with `npm ci`, runs `npm run check` (typecheck, 327 unit tests, production build, dist validation), builds the deterministic archive with `npm run package`, prints its SHA-256, and uploads `lingolens-extension.zip` as a workflow artifact.

## Releasing

Releases are driven by `v*` tags and handled by `.github/workflows/release.yml`.

```bash
# 1. Bump the version in package.json and public/manifest.json
# 2. Commit the change, then create and push an annotated tag
git commit -am "chore: release v0.1.1"
git tag -a v0.1.1 -m "LingoLens v0.1.1"
git push origin main v0.1.1
```

The workflow then:

1. checks that the tag matches both `package.json` and `public/manifest.json` versions and fails otherwise;
2. runs the full `npm run check` gate;
3. builds the deterministic archive with `npm run package`;
4. creates a GitHub Release named `LingoLens vX.Y.Z`, attaches `lingolens-extension.zip`, and records its SHA-256;
5. uploads the archive as a workflow artifact (30 days).

Existing releases can be re-published from the Actions tab with **Run workflow**, supplying the tag to publish; the archive is re-uploaded with `--clobber` instead of creating a duplicate release.

## API configuration

| Provider | Default API base URL | Default model |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4.1-mini` |
| Custom | Empty — fill in your own endpoint | Empty — fill in your own model |

Image translation uses **图片模型** when it is set and falls back to the model above otherwise.

For a custom provider, enter either the API root or the full `/chat/completions` URL. A prefilled address does not imply permission. Remote HTTP sends the API key and page text in plaintext and requires explicit consent in settings; without it, saving, testing, permission requests, and translation are all refused. HTTPS and `localhost` / `127.0.0.1` HTTP are exempt.

## Privacy and security

- The API key is written only to `chrome.storage.local` and never inserted into page DOM.
- Page text and the API key are sent to the provider you configure. When you use a shared relay, they pass through that relay. Remote HTTP transmits both in plaintext; an address being prefilled does not imply authorization, and you must explicitly accept the risk.
- The extension does not run on all pages. It is injected through `activeTab` only after you click the icon, press the shortcut, or use the context menu.
- Custom providers require an explicit per-origin permission request. Remote HTTP additionally requires the risk consent.
- PDF URLs are bound to a tab's source record in `chrome.storage.session` and expire; files chosen with the local picker are never stored.
- PDF text is sent directly to your configured provider. Scanned PDFs and OCR are not supported.
- Screenshots are sent to the configured provider only when you submit them for image translation, and are never written to storage.

## Scope and limits

This version covers in-page bilingual reading, text-layer PDF translation, and single-image translation through a vision model. It does not include PDF OCR, video subtitles, multi-image OCR, manga translation, or account sync. Image results are plain text and do not preserve the original layout.

PDF limits: text layer only; files up to 50 MiB, up to 300 pages, and up to 500,000 extracted characters. Language detection samples the first three non-empty pages (up to 4,000 characters) and runs once per document.

Verified on Chrome 150 and Chrome 155 (155.0.8059.39). The Chrome 115 minimum has not been verified on a physical machine.
