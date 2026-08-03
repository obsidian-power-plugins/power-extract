# Power Extract

Reads the text inside your images so other plugins can search it. No downloads, no accounts, no uploads: the recognizer is the one already built into Windows, and every image is read on your own machine.

[![Buy me a coffee](https://cdn.buymeacoffee.com/buttons/default-yellow.png)](https://buymeacoffee.com/powerplugins)

## What it is for

A vault full of screenshots is a vault full of text you cannot search. Paste a screenshot of an error message, a receipt, or a slide, and to Obsidian it is a file with a name and nothing else.

Power Extract is a companion plugin: it does not add a view or change how anything looks. It reads images and hands the text to whatever asks for it. [Power Explorer](https://github.com/obsidian-power-plugins/obsidian-power-explorer) uses it to make screenshots turn up in search, and [Power Assistant](https://github.com/obsidian-power-plugins/obsidian-power-assistant) uses it to read a receipt or a bill before filing it.

You can also use it directly: right-click any image and choose **Copy text from image**, or run **Copy the text from an image** from the command palette and pick one.

## How it reads

Windows has shipped an OCR engine since Windows 10, the same one behind Snipping Tool's text actions. Power Extract uses that, which is why it needs nothing installed and nothing downloaded.

Reaching it takes a short PowerShell script, because the engine is a Windows Runtime API that Obsidian itself cannot call. **This plugin therefore starts `powershell.exe`,** which is worth stating plainly:

- The script is written to this plugin's own folder (`ocr-worker.ps1`) the first time an image is read, and is rewritten whenever the plugin updates. Nothing is downloaded, and it is not run from a temporary folder.
- It is started with `-NoProfile -NonInteractive -File`. There is no execution-policy override, no encoded command, and no hidden window flag beyond the one that stops a console flashing on screen.
- It receives file paths and returns text. It opens no network connection and writes no file.
- One process serves every image and shuts itself down after 30 seconds with nothing to do, so nothing lingers when you are not using it.

You can read the whole script: it is in `src/worker.ts` in this repository, and on disk in the plugin's folder once it has run.

## What it reads, and where

- **Images:** png, jpg, jpeg, bmp, gif, and webp where Windows has the codec.
- **Once each.** What comes out is remembered in `ocr-cache.json` next to the plugin, keyed by the file's modification time and size, so an image is read once and never again until it changes. A vault of 13,000 screenshots takes about eight minutes to get through the first time, and nothing after that.
- **Desktop Windows does the reading.** On macOS, Linux, and mobile there is no engine to call, so a plugin that asks gets a clear answer saying so. Anything already read stays readable everywhere, because the cache travels with the vault.

## Settings

- **This device** reports whether reading can happen here, and in which language.
- **Text already read** shows how much is cached, with **Forget all** to clear it and **Tidy up** to drop text for images the vault no longer has.
- **Right-click an image to read it** turns the menu entry on and off.
- **Remember what was read** turns the cache off, for anyone who would rather spend the time than the disk.

## For plugin authors

Power Extract exposes the same API shape as the Text Extractor plugin, so supporting both is a matter of trying both ids:

```js
const api =
    app.plugins.plugins["powerextract"]?.api ??
    app.plugins.plugins["text-extractor"]?.api;

if (api) {
    const text = await api.extractText(file); // file: TFile
}
```

The full surface:

| Method | Returns |
| --- | --- |
| `extractText(file)` | `Promise<string>` — the text, from cache when it is there. Rejects if this device cannot read images, or if this file could not be read. |
| `canExtract(file)` | `boolean` — whether this is a file type it reads. |
| `isAvailable()` | `boolean` — whether this device can read anything at all. |
| `language()` | `string \| null` — the recognizer's language tag, once one has started. |

Two callers asking for the same image at once wait on a single read rather than starting two.

## Install

Not in the community catalog yet. Until then: download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/obsidian-power-plugins/power-extract/releases), put them in `<vault>/.obsidian/plugins/powerextract/`, and enable the plugin in **Settings → Community plugins**.

## Build

```bash
pnpm install
npm test
npm run build
```

`npm run deploy` copies the built plugin into every Obsidian vault registered on the machine, refusing to overwrite a vault holding a newer version.

## License

MIT
