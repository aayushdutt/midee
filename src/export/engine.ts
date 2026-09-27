// Which browser engine runs the export — only where the engine changes what
// the encoder does best (VideoExporter's defaultLatencyMode). WebKit =
// Safari, and every browser on iOS (CriOS / FxiOS / EdgiOS are WebKit and
// share Safari's encoder). Desktop and Android Chromium carry "Chrome/",
// Firefox carries "Firefox/", Edge "Edg/".
export function isWebKit(
  ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
): boolean {
  return /AppleWebKit/.test(ua) && !/Chrome\/|Chromium\/|Firefox\/|Edg\//.test(ua)
}
