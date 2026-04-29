const INPUT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

export function isKeyboardShortcutIgnored(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return true
  const target = e.target as HTMLElement | null
  return target !== null && INPUT_TAGS.has(target.tagName)
}
