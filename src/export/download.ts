// Hands a finished export to the browser's normal download (the downloads UI
// is where a user opens or reveals the file). The object URL stays alive until
// the next download instead of being revoked on a timer: the browser may still
// be reading a multi-GB file — or waiting on iOS Safari's "Download?" prompt —
// long after the click, and revoking early breaks the download ("WebKitBlobResource
// error 1" on iOS; Chrome has a similar race). Cost: the last export's Blob is
// kept until the next one or until the page goes away — for an MP4 streamed to
// OPFS that Blob is a reference to the file on disk, not a copy in RAM, and
// the file itself lives until the next export (opfsExports.ts).

let lastUrl: string | null = null

export function downloadBlob(blob: Blob, filename: string): void {
  if (lastUrl) URL.revokeObjectURL(lastUrl)
  lastUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = lastUrl
  a.download = filename
  a.click()
}
