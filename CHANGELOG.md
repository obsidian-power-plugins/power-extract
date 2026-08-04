# Changelog

All notable changes to Power Extract. Dates are when the version was cut.

## 1.1.2 - 2026-08-03

### Changed

- The settings tab reaches its pre-1.13 redraw through the same cast that
  checks for the 1.13 one, so the fallback is no longer reported as a
  deprecated call. Behavior is unchanged on either version.

## 1.1.1 - 2026-08-03

### Changed

- The worker is started through a plain import of `node:child_process` rather
  than a lazy `require`, and the Windows check now asks Obsidian's own
  `Platform.isWin` instead of reading Node's `process`. The plugin is
  desktop-only, so nothing was gained by deferring either one, and neither now
  depends on Node's ambient types being present to type-check.
- Timers are scheduled with `window.setTimeout`, so a timer belongs to the
  window it was started in and survives a popout.

### Fixed

- A line from the worker that parses as valid JSON but is not an object (a bare
  number, or `null`) is now rejected as unrecognized instead of being read as a
  job result.

## 1.1.0 - 2026-08-03

### Changed

- **Desktop only.** Reading an image means starting `powershell.exe`, and a plugin that reaches for a process has to declare it, so `isDesktopOnly` is now true and Obsidian no longer offers Power Extract on a phone or tablet. The cost is worth naming plainly: 1.0.0 installed on mobile and served text it had already read out of the cache, which is how a screenshot turned up in Power Explorer's search there. That no longer happens. Nothing changes on desktop, macOS and Linux included, where the cache still answers for images this machine cannot read itself.

## 1.0.0 - 2026-08-02

First release. Replaces the Text Extractor plugin for the one thing it was being used for in this suite: reading the text inside images.

### Added

- **Text out of images, through the OCR built into Windows.** Nothing is downloaded and no image leaves the machine. Measured against the plugin this replaces, across 80 images taken from a real vault: 30 of the 40 images tesseract.js had given up on came back with text, the same images yielded 39,435 characters against 25,364, and the share of output that is made of real words went from 0.55 to 0.70. An image takes about 35ms rather than seconds, which puts a 13,000-image vault at roughly eight minutes rather than most of a day.
- **A worker that stays up.** Standing the recognizer up costs about 220ms and reading an image costs about 35ms, so a process per image would spend six times longer starting than working. One PowerShell worker takes images one at a time for as long as there is work, then shuts itself down after 30 seconds of quiet so nothing lingers.
- **A cache that is one file.** The plugin this replaces wrote a separate JSON per image and had accumulated 13,200 of them in a folder every sync tool has to walk on every pass. The same content is one object here, keyed by modification time and size so a file restored from a backup is noticed and re-read.
- **Copy text from image**, on the right-click menu of any image and in the command palette.
- **An API for other plugins**, the same shape Text Extractor exposes, so supporting both is a matter of trying both ids.

### Notes

- Reading happens on desktop Windows. macOS, Linux, and mobile have no engine to call and are told so plainly; anything already read stays readable everywhere, because the cache travels with the vault.
- Reaching the Windows recognizer means starting `powershell.exe`. The README says exactly how, and the script it runs is in `src/worker.ts`.
