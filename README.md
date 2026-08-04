# Power Extract

Reads the text inside your images so other plugins can search it. No downloads, no accounts, no uploads: the recognizer is the one already built into Windows, and every image is read on your own machine.

[![Buy me a coffee](docs/images/buy-me-a-coffee.png)](https://buymeacoffee.com/powerplugins)

## What it is for

A vault full of screenshots is a vault full of text you cannot search. Paste a screenshot of an error message, a receipt, or a slide, and to Obsidian it is a file with a name and nothing else.

Power Extract is a companion plugin: it does not add a view or change how anything looks. It reads images and hands the text to whatever asks for it. [Power Explorer](https://github.com/obsidian-power-plugins/obsidian-power-explorer) uses it to make screenshots turn up in search, and [Power Assistant](https://github.com/obsidian-power-plugins/obsidian-power-assistant) uses it to read a receipt or a bill before filing it.

You can also use it directly: right-click any image and choose **Copy text from image**, or run **Copy the text from an image** from the command palette and pick one.

## How it reads

Windows has shipped an OCR engine since Windows 10, the same one behind Snipping Tool's text actions. Power Extract uses that, which is why it needs nothing installed and nothing downloaded.

Reaching it takes a short PowerShell script, because the engine is a Windows Runtime API that Obsidian itself cannot call. **This plugin therefore starts `powershell.exe`,** which is worth stating plainly:

- **A fixed program, at a fixed path, with fixed arguments.** The host is named by its full path, `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, so a file called `powershell.exe` sitting somewhere earlier in the search order cannot answer instead. The arguments are `-NoProfile -NonInteractive -File <script>` and never anything else. There is no shell in between, no execution-policy override, and no encoded command.
- **Nothing you type reaches it.** Image paths are sent to the running worker over stdin, not on a command line, so no file name and no setting can turn into a second command.
- **The script is the one shipped in `main.js`.** It is written to this plugin's own folder as `ocr-worker.ps1`, and it is read back and compared against the shipped copy before every start. Anything that differs is overwritten first. That folder lives in your vault, where sync services write and other applications can reach, so an edit from any source is undone rather than run.
- **It reads images and returns text.** It opens no network connection and writes no file.
- **One process serves every image** and shuts itself down after 30 seconds with nothing to do, so nothing lingers when you are not using it.

You can read the whole script: it is in `src/worker.ts` in this repository, and on disk in the plugin's folder once it has run.

## What it can reach on your machine

The community catalog's scan reports what a plugin is capable of, not what it does with it. Power Extract reaches for three things, and each one is here for a reason you can check in the source.

| What the scan reports | What it is | Where |
| --- | --- | --- |
| **Shell execution** via `child_process` | Starting the OCR host described above. There is one call, it takes no input from anywhere, and it is the only way to reach the Windows recognizer from a plugin. | [`src/main.ts`](src/main.ts), `spawnWorker` |
| **Vault enumeration** | Listing your files, twice: to offer image files in the **Copy the text from an image** picker, and to find cached text belonging to images the vault no longer has, so **Tidy up** can drop it. Only paths and extensions are looked at, and the list never leaves Obsidian. | [`src/main.ts`](src/main.ts), `prune` and `ImagePickerModal` |
| **Clipboard access** | Writing, never reading. One line, reached only from the menu item or the command you just chose, and what it puts there is the text from the image you picked. The plugin never asks what was on your clipboard before. | [`src/main.ts`](src/main.ts), `copyTextToClipboard` |

There is no network code in this plugin at all: no `fetch`, no `XMLHttpRequest`, no `requestUrl`. Images are read on your machine and the text stays there.

## What it reads, and where

- **Images:** png, jpg, jpeg, bmp, gif, and webp where Windows has the codec.
- **Once each.** What comes out is remembered in `ocr-cache.json` next to the plugin, keyed by the file's modification time and size, so an image is read once and never again until it changes. A vault of 13,000 screenshots takes about eight minutes to get through the first time, and nothing after that.
- **Desktop Windows does the reading, and the plugin is desktop only.** Reaching the recognizer means starting a process, which the mobile app cannot do, so Obsidian does not offer Power Extract on a phone or tablet. On desktop macOS and Linux there is no engine to call and a plugin that asks gets a clear answer saying so, but anything already read stays readable there, because the cache travels with the vault.

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
