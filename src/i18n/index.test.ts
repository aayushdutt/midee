import { afterEach, describe, expect, it } from 'vitest'
import { watch } from '../store/watch'
import { formatNumber, initI18n, locale, setLocale, t, tn } from './index'
import { en } from './locales/en'
import zhCN from './locales/zh-CN'

// These tests cover the pure-function surface of i18n: `t`, `tn`, and the
// native-Intl helpers. They do not exercise `initI18n` / `setLocale` (which
// touch localStorage, navigator, dynamic imports) — that path needs a real
// browser environment and isn't worth mocking. The pure-function surface is
// where regressions actually slip through (typo'd keys, wrong plural form,
// botched interpolation).

const originalLocale = locale.value
const originalUrl = new URL(window.location.href)
const originalHistoryPath = `${originalUrl.pathname}${originalUrl.search}${originalUrl.hash}`
const originalNavigatorLanguage = navigator.language

afterEach(async () => {
  // tn() picks plural form based on `locale.value`; restore so test order
  // doesn't matter.
  await setLocale(originalLocale)
  localStorage.clear()
  document.documentElement.lang = originalLocale
  window.history.replaceState({}, '', originalHistoryPath)
  Object.defineProperty(window.navigator, 'language', {
    value: originalNavigatorLanguage,
    configurable: true,
  })
})

describe('t()', () => {
  it('returns the message for a known key', () => {
    expect(t('home.cta.openMidi')).toBe(en['home.cta.openMidi'])
  })

  it('substitutes {var} placeholders', () => {
    const out = t('toast.export.ready', { filename: 'midee.mp4' })
    expect(out).toBe('midee.mp4 ready')
  })

  it('leaves {var} placeholders intact when no value is supplied', () => {
    // Better than printing "undefined" — at least the next agent sees the
    // missing variable name in the wild.
    const out = t('toast.export.ready')
    expect(out).toBe('{filename} ready')
  })

  it('falls back to the key itself when neither current nor en have it', () => {
    // Force-cast through `unknown` to bypass the compile-time key check —
    // simulating what would happen at runtime if a stale string slipped in.
    const out = t('this.does.not.exist' as unknown as keyof typeof en)
    expect(out).toBe('this.does.not.exist')
  })
})

describe('tn()', () => {
  it('uses .one for count=1 in English', () => {
    expect(tn('tracks.notes', 1, { channel: 1 })).toBe('ch 1 · 1 note')
  })

  it('uses .other for count=0 and count>1 in English', () => {
    expect(tn('tracks.notes', 0, { channel: 1 })).toBe('ch 1 · 0 notes')
    expect(tn('tracks.notes', 2, { channel: 1 })).toBe('ch 1 · 2 notes')
    expect(tn('tracks.notes', 12, { channel: 4 })).toBe('ch 4 · 12 notes')
  })

  it('injects {count} automatically — caller does not have to pass it', () => {
    // Plural keys reference {count} but the call site only passes domain
    // params (e.g. `channel`). tn() merges count in.
    expect(tn('tracks.notes', 7, { channel: 9 })).toContain('7 notes')
  })

  it('postSession.stats interpolates both {count} and {duration}', () => {
    expect(tn('postSession.stats', 5, { duration: '0:30' })).toBe('0:30 · 5 notes')
    expect(tn('postSession.stats', 1, { duration: '0:30' })).toBe('0:30 · 1 note')
  })
})

describe('formatNumber()', () => {
  it('formats numbers using the current locale', () => {
    // English uses "." as decimal separator; testing in default (en) locale.
    expect(formatNumber(1234.5)).toBe('1,234.5')
  })
})

describe('zh-CN locale', () => {
  it('loads translated strings and plural keys', async () => {
    await setLocale('zh-CN')

    expect(t('home.cta.openMidi')).toBe(zhCN['home.cta.openMidi'])
    expect(tn('tracks.notes', 2, { channel: 3 })).toBe('3 声部 · 2 个音符')
    expect(formatNumber(1234.5)).toBe(new Intl.NumberFormat('zh-CN').format(1234.5))
  })

  it('initI18n honors the ?lang=zh-CN URL override', async () => {
    window.history.replaceState({}, '', '?lang=zh-CN')

    await initI18n()

    expect(locale.value).toBe('zh-CN')
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(t('customize.language')).toBe(zhCN['customize.language'])
  })

  it('maps a base zh browser language to zh-CN', async () => {
    Object.defineProperty(window.navigator, 'language', {
      value: 'zh',
      configurable: true,
    })

    await initI18n()

    expect(locale.value).toBe('zh-CN')
    expect(document.documentElement.lang).toBe('zh-CN')
  })
})

describe('reactivity', () => {
  it('t() re-runs inside a tracking scope when setLocale flips the messages', async () => {
    // Every JSX surface calling t() depends on this — without it, locale
    // changes would leave stale strings on screen until a remount.
    const seen: string[] = []
    const stop = watch(
      () => t('home.cta.openMidi'),
      (v) => seen.push(v),
    )
    await setLocale('fr')
    stop()
    // watch() defers the initial read — only the locale flip fires.
    expect(seen.length).toBe(1)
    expect(seen[0]).not.toBe(en['home.cta.openMidi'])
    // Reset for subsequent tests.
    await setLocale('en')
  })
})
