/**
 * The OCR worker: the source that ships inside main.js, and how it is started.
 *
 * Obsidian installs exactly three files (manifest.json, main.js, styles.css),
 * so a companion script cannot ride along as a fourth. It travels as this
 * string instead and is written next to the plugin the first time OCR is
 * asked for.
 *
 * Why a separate process at all: the recognizer is Windows.Media.Ocr, a WinRT
 * API. Electron's renderer cannot reach it and a Node addon cannot ship in a
 * community plugin, so the one way in is a host that already projects WinRT,
 * which is Windows PowerShell.
 *
 * Why it stays running: standing the engine up costs about 220ms and a single
 * image costs about 35ms, so a process per image would spend six times longer
 * starting than working. One worker reads jobs for as long as there is work.
 *
 * Two rules this file keeps, both enforced by tests:
 *
 * - Plain ASCII only. Windows PowerShell reads a .ps1 as ANSI unless it finds
 *   a BOM, so a non-ASCII character here would arrive mangled at the one place
 *   that would be hardest to explain.
 * - No backticks. PowerShell's escape character is also JavaScript's template
 *   delimiter, and a script that has to be stitched together around them is
 *   one bad edit from silently becoming a different script. Everywhere the
 *   obvious PowerShell would reach for one, this uses the regex spelling
 *   instead: "\t" for a tab, -like for the generic type name.
 */

/** Where the recognizer's host lives, given the value of %SystemRoot%.
 *
 *  An absolute path rather than the bare name. Started without a shell, Windows
 *  resolves a bare program name against the calling process's own directory and
 *  the working directory before it ever reaches PATH, so a file named
 *  powershell.exe dropped in either one would be started in place of the real
 *  one. Naming the path outright takes that away.
 *
 *  The bare name is left as the answer only when the environment has no
 *  SystemRoot at all, where a guessed path would be worse than letting Windows
 *  look. */
export function powershellPath(systemRoot: string | undefined | null): string {
	const root = (systemRoot ?? "").trim().replace(/[\\/]+$/, "");
	if (!root) return "powershell.exe";
	return root + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
}

/** Everything the host is asked for, and nothing else.
 *
 *  No execution-policy override: the script is written by the plugin rather than
 *  downloaded, so it carries no mark of the web and the default RemoteSigned
 *  policy runs it as it stands. No encoded command either, so what runs is a
 *  file on disk that anyone can open and read. Both are checked by a test,
 *  because they are the kind of flag that gets added in a hurry while debugging
 *  and then never taken out again. */
export function workerArgs(scriptPath: string): string[] {
	return ["-NoProfile", "-NonInteractive", "-File", scriptPath];
}

export const OCR_WORKER_PS1 = String.raw`
# Power Extract OCR worker. Written by the plugin; safe to delete when it is
# not running (it is recreated on demand).
#
# Protocol, one line each way:
#   in   <id> TAB <absolute path>      "@@quit" to stop
#   out  {"id":"..","text":".."} or {"id":"..","err":".."}
# The first line out is {"ready":true,"lang":".."}, or {"ready":false} when
# this machine has no recognizer, which is the parent's signal to stop asking.

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false

# WinRT hands back IAsyncOperation; this is the reflection dance that turns one
# into a Task that Windows PowerShell can wait on. The parameter type is
# matched with -like so its generic arity suffix stays out of this file.
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*'
})[0]

function Await($op, $type) {
    $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
    $t.Wait(-1) | Out-Null
    $t.Result
}

function Emit($obj) {
    # One object, one line. Depth 3 is plenty for what we send and stops a
    # surprise from spilling across lines and desynchronizing the parent.
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 3))
    [Console]::Out.Flush()
}

try {
    [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
    [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
    [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
    [Windows.Storage.Streams.DataWriter, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
} catch {
    $engine = $null
}

# No engine is a fact about the machine, not a failure of a job: an N edition
# without the Media Feature Pack, or a display language with no recognizer.
if ($null -eq $engine) { Emit ([pscustomobject]@{ ready = $false }); exit 1 }
Emit ([pscustomobject]@{ ready = $true; lang = $engine.RecognizerLanguage.LanguageTag })

while ($null -ne ($line = [Console]::In.ReadLine())) {
    if ($line -eq '@@quit') { break }
    # Split once, on a regex tab: a file name may contain a tab, an id never does.
    $id, $path = $line -split "\t", 2
    $bitmap = $null
    $stream = $null
    try {
        # Read the bytes here rather than going through StorageFile, which wants
        # a broker that is not always running and refuses some paths the
        # filesystem is perfectly happy with.
        $bytes = [IO.File]::ReadAllBytes($path)
        $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
        $writer = New-Object Windows.Storage.Streams.DataWriter $stream
        $writer.WriteBytes($bytes)
        Await ($writer.StoreAsync()) ([uint32]) | Out-Null
        $writer.DetachStream() | Out-Null
        $stream.Seek(0)
        $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
        $text = $result.Text
        if ($null -eq $text) { $text = "" }
        Emit ([pscustomobject]@{ id = $id; text = $text })
    } catch {
        # A file that is missing, not an image, or in a format with no codec on
        # this machine is one job's problem. Report it and stay up.
        Emit ([pscustomobject]@{ id = $id; err = ($_.Exception.Message -replace '\s+', ' ') })
    } finally {
        if ($null -ne $bitmap) { $bitmap.Dispose() }
        if ($null -ne $stream) { $stream.Dispose() }
    }
}
`;
