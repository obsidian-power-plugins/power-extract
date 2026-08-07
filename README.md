# Power Extract

Reads the text inside your images so you can search it. No downloads, no accounts, no uploads: it uses the recognizer already built into Windows, and every image is read on your own machine.

## What it is for

A vault full of screenshots is a vault full of text you cannot search. Paste a screenshot of an error message, a receipt, or a slide, and to Obsidian it is a file with a name and nothing else.

Power Extract works quietly in the background. It adds no view and changes nothing about how your vault looks. It reads images and hands the text to whatever asks for it: [Power Explorer](https://github.com/obsidian-power-plugins/obsidian-power-explorer) makes screenshots turn up in search, and [Power Assistant](https://github.com/obsidian-power-plugins/obsidian-power-assistant) reads a receipt or a bill before filing it.

You can use it directly too. Right-click any image and choose **Copy text from image**.

## How it reads

Windows has shipped a text recognizer since Windows 10, the same one behind Snipping Tool. Power Extract uses it, which is why nothing needs installing.

Reaching it takes a short PowerShell script, because it is a Windows API that Obsidian cannot call on its own. **So this plugin starts `powershell.exe`,** which is worth stating plainly:

- **A fixed program, at a fixed path, with fixed arguments.** Named by full path, so an imposter earlier in the search order cannot answer instead. No shell in between, no execution-policy override, no encoded command.
- **Nothing you type reaches it.** Image paths go over stdin, not a command line, so no file name or setting can turn into a second command.
- **The script is the one shipped inside the plugin,** checked against the shipped copy before every start. It lives in your vault where sync services and other apps can reach it, so an edit from any source is overwritten rather than run.
- **It reads images and returns text.** No network connection, no files written.
- **One process serves every image** and shuts down after 30 seconds of quiet.

You can read the whole script: `src/worker.ts` here, and on disk once it has run.

## What it can reach on your machine

The community catalog's scan reports what a plugin is *capable* of, not what it does with it. Power Extract reaches for three things.

| What the scan reports | What it is | Where |
| --- | --- | --- |
| **Shell execution** via `child_process` | Starting the recognizer described above. One call, no input from anywhere, and the only way to reach it from a plugin. | [`src/main.ts`](src/main.ts), `spawnWorker` |
| **Vault enumeration** | Listing files, twice: to offer images in the picker, and to find cached text for images the vault no longer has so **Tidy up** can drop it. Only paths and extensions, and the list never leaves Obsidian. | [`src/main.ts`](src/main.ts), `prune` and `ImagePickerModal` |
| **Clipboard access** | Writing, never reading. One line, reached only from the menu item or command you just chose. The plugin never asks what was on your clipboard before. | [`src/main.ts`](src/main.ts), `copyTextToClipboard` |

There is no network code in this plugin at all: no `fetch`, no `XMLHttpRequest`, no `requestUrl`. Images are read on your machine and the text stays there.

## What it reads, and where

- **Images:** png, jpg, jpeg, bmp, gif, and webp where Windows has the codec.
- **Once each.** The result is remembered, keyed to the file's size and modified time, so an image is read once and never again until it changes. A vault of 13,000 screenshots takes about eight minutes the first time, and nothing after that.
- **Windows desktop only.** Reaching the recognizer means starting a process, which phones cannot do. On macOS and Linux there is no engine to call and you get a clear answer saying so, but anything already read stays readable, because the cache travels with the vault.

## Settings

- **This device** reports whether reading can happen here, and in which language.
- **Text already read** shows how much is cached, with **Forget all** and **Tidy up**.
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

Also on the API: `canExtract(file)` and `isAvailable()` return booleans, and `language()` returns the recognizer's language tag. Two callers asking for the same image at once wait on a single read rather than starting two.

## More Power Plugins

Each one works on its own, and they fit together when you have more than one.

- **[Power Assistant](https://github.com/obsidian-power-plugins/obsidian-power-assistant)**: record and summarize meetings, capture anything from a link, and ask your notes questions.
- **[Power Bases](https://github.com/obsidian-power-plugins/obsidian-power-bases)**: board, calendar, timeline, chart, and gallery views for Bases.
- **[Power Connect](https://github.com/obsidian-power-plugins/obsidian-power-connect)**: sync your vault through your own Dropbox, OneDrive, or Google Drive.
- **[Power Desk](https://github.com/obsidian-power-plugins/obsidian-power-desk)**: your calendars and your mail, inside your vault.
- **[Power Editor](https://github.com/obsidian-power-plugins/obsidian-power-editor)**: a formatting toolbar, drag-and-drop blocks, and WYSIWYG editing.
- **[Power Explorer](https://github.com/obsidian-power-plugins/obsidian-power-explorer)**: arrange files by hand, and search a huge vault instantly.
- **[Power Tables](https://github.com/obsidian-power-plugins/obsidian-power-tables)**: colors, live formulas, and sorting for Markdown tables.

## Build

```bash
pnpm install
npm test
npm run build
```

## License

MIT

## Support

Power Extract is built and maintained by one person. If it earns a place in your daily vault, you can [buy me a coffee](https://buymeacoffee.com/powerplugins). Nothing in the plugin is held back either way.

[![Buy me a coffee](docs/images/buy-me-a-coffee.png)](https://buymeacoffee.com/powerplugins)
