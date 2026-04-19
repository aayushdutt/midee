import type { Theme } from '../renderer/theme'
import type { ParticleStyleInfo, ParticleStyle } from '../renderer/ParticleSystem'
import { LOCALES, locale, t, type LocaleCode } from '../i18n'
import { isNarrowViewport } from './utils'

// Aesthetics popover — collapses theme, particles, and chord overlay (three
// previously-separate topbar pills) into one trigger. Reduces topbar noise
// while keeping every option one tap away once opened.
//
// Pattern mirrors InstrumentMenu: a pill trigger anchored in the topbar +
// an absolutely-positioned popover anchored under it (or rendered as a
// bottom sheet on narrow viewports via shared CSS).

export interface CustomizeMenuCallbacks {
  onSelectTheme:    (index: number) => void
  onSelectParticle: (index: number) => void
  onToggleChord:    () => void
  onSelectLocale:   (code: LocaleCode) => void
}

export class CustomizeMenu {
  readonly trigger: HTMLButtonElement
  private menu: HTMLElement
  private themeRowEl: HTMLElement
  private particleRowEl: HTMLElement
  private chordToggleEl: HTMLButtonElement
  private localeRowEl: HTMLElement
  private themeDotEl: HTMLElement
  private isOpen = false

  private currentThemeIndex = 0
  private currentParticleIndex = 0
  private chordOn = false

  private onDocPointer = (e: PointerEvent): void => {
    const target = e.target as Node
    if (this.menu.contains(target)) return
    if (this.trigger.contains(target)) return
    this.close()
  }
  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.isOpen) this.close()
  }
  private onResize = (): void => {
    if (!this.isOpen) return
    if (this.menu.classList.contains('popover--sheet') || isNarrowViewport()) {
      this.close()
      return
    }
    this.positionUnder()
  }

  constructor(
    triggerHost: HTMLElement,
    popoverHost: HTMLElement,
    private themes: readonly Theme[],
    private particles: readonly ParticleStyleInfo[],
    private callbacks: CustomizeMenuCallbacks,
  ) {
    this.trigger = document.createElement('button')
    this.trigger.className = 'ts-pill ts-pill--customize'
    this.trigger.id = 'ts-customize'
    this.trigger.type = 'button'
    this.trigger.setAttribute('aria-label', t('customize.aria'))
    this.trigger.setAttribute('data-tip', t('customize.aria'))
    this.trigger.innerHTML = `
      <span class="ts-customize-swatch" aria-hidden="true" id="ts-customize-swatch"></span>
      <span class="ts-customize-label" id="ts-customize-label">${t('customize.theme')}</span>
      ${ICON_CHEV}
    `
    this.themeDotEl = this.trigger.querySelector<HTMLElement>('#ts-customize-swatch')!
    this.trigger.addEventListener('click', () => this.toggle())
    triggerHost.appendChild(this.trigger)

    this.menu = document.createElement('div')
    this.menu.className = 'ts-popover ts-customize-menu'
    this.menu.innerHTML = `
      <div class="panel-header">
        <span class="panel-label">${t('customize.title')}</span>
      </div>

      <div class="customize-section">
        <div class="customize-section-head">
          <span class="customize-section-label">${t('customize.theme')}</span>
        </div>
        <div class="customize-theme-grid" data-role="theme-row"></div>
      </div>

      <div class="customize-section">
        <div class="customize-section-head">
          <span class="customize-section-label">${t('customize.particles')}</span>
        </div>
        <div class="customize-particle-row" data-role="particle-row"></div>
      </div>

      <div class="customize-section">
        <div class="customize-section-head">
          <span class="customize-section-label">${t('customize.language')}</span>
        </div>
        <div class="customize-locale-row" data-role="locale-row"></div>
      </div>

      <div class="customize-section customize-section--toggle">
        <button class="customize-toggle" type="button" data-role="chord-toggle"
                aria-pressed="false">
          <span class="customize-toggle-body">
            <span class="customize-toggle-name">${t('customize.chord')}</span>
            <span class="customize-toggle-sub">${t('customize.chord.sub')}</span>
          </span>
          <span class="customize-toggle-switch" aria-hidden="true">
            <span class="customize-toggle-knob"></span>
          </span>
        </button>
      </div>
    `
    popoverHost.appendChild(this.menu)

    this.themeRowEl = this.menu.querySelector<HTMLElement>('[data-role="theme-row"]')!
    this.particleRowEl = this.menu.querySelector<HTMLElement>('[data-role="particle-row"]')!
    this.chordToggleEl = this.menu.querySelector<HTMLButtonElement>('[data-role="chord-toggle"]')!
    this.localeRowEl = this.menu.querySelector<HTMLElement>('[data-role="locale-row"]')!

    this.buildThemeRow()
    this.buildParticleRow()
    this.buildLocaleRow()
    this.chordToggleEl.addEventListener('click', () => {
      this.callbacks.onToggleChord()
    })
  }

  private buildLocaleRow(): void {
    // Native names — users recognise their own language. Active state pulled
    // from the i18n locale Signal so the active chip stays in sync if the
    // locale changes from anywhere else.
    this.localeRowEl.innerHTML = LOCALES.map((l) => `
      <button class="customize-locale-chip${l.code === locale.value ? ' customize-locale-chip--on' : ''}"
              type="button" data-locale="${l.code}" aria-label="${l.nativeName}">
        <span class="customize-locale-chip-label">${l.nativeName}</span>
      </button>
    `).join('')
    this.localeRowEl.querySelectorAll<HTMLButtonElement>('.customize-locale-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const code = btn.dataset['locale'] as LocaleCode | undefined
        if (code) this.callbacks.onSelectLocale(code)
      })
    })
  }

  // ── Public state setters (App pushes the active selection in) ──────────
  setTheme(index: number): void {
    this.currentThemeIndex = index
    const theme = this.themes[index]
    if (!theme) return
    // Trigger swatch — small gradient that previews the theme's accent +
    // a track-color companion so the pill itself reads as a thumbnail.
    const accent = theme.uiAccentCSS
    const second = numToHexCss(theme.trackColors[2] ?? theme.trackColors[0] ?? 0xffffff)
    this.themeDotEl.style.background = `linear-gradient(135deg, ${accent}, ${second})`
    this.themeDotEl.style.boxShadow = `0 0 0 1px rgba(255, 255, 255, 0.18) inset, 0 0 12px ${accent}55`
    const labelEl = this.trigger.querySelector<HTMLElement>('#ts-customize-label')
    if (labelEl) labelEl.textContent = theme.name
    this.themeRowEl.querySelectorAll<HTMLButtonElement>('.customize-theme-tile').forEach(btn => {
      btn.classList.toggle('customize-theme-tile--on', Number(btn.dataset['index']) === index)
    })
  }

  setParticle(index: number): void {
    this.currentParticleIndex = index
    const p = this.particles[index]
    if (!p) return
    this.particleRowEl.querySelectorAll<HTMLButtonElement>('.customize-particle-chip').forEach(btn => {
      btn.classList.toggle('customize-particle-chip--on', Number(btn.dataset['index']) === index)
    })
  }

  setChord(on: boolean): void {
    this.chordOn = on
    this.chordToggleEl.setAttribute('aria-pressed', String(on))
    this.chordToggleEl.classList.toggle('customize-toggle--on', on)
  }

  // ── Private builders ──────────────────────────────────────────────────
  private buildThemeRow(): void {
    // Minimal: a single flat accent-colour dot per theme. Modern, calm, and
    // still distinct because each theme's accent is unique.
    this.themeRowEl.innerHTML = this.themes.map((t, i) => `
      <button class="customize-theme-tile" type="button" data-index="${i}"
              title="${t.name}" aria-label="${t.name} theme">
        <span class="customize-theme-tile-dot" style="background:${t.uiAccentCSS};"></span>
        <span class="customize-theme-tile-label">${t.name}</span>
      </button>
    `).join('')
    this.themeRowEl.querySelectorAll<HTMLButtonElement>('.customize-theme-tile').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset['index'])
        if (Number.isFinite(idx)) this.callbacks.onSelectTheme(idx)
      })
    })
  }

  private buildParticleRow(): void {
    // Per-style mini-glyphs evoke the actual particle behaviour (a burst, a
    // trail, a halo). Plain dots would all look the same — these read at a
    // glance which style does what without forcing the user to A/B-toggle.
    this.particleRowEl.innerHTML = this.particles.map((p, i) => `
      <button class="customize-particle-chip" type="button" data-index="${i}"
              title="${p.name}" aria-label="${p.name} particles">
        <span class="customize-particle-chip-glyph" data-style="${p.id}" aria-hidden="true">
          ${PARTICLE_GLYPHS[p.id] ?? PARTICLE_GLYPHS['sparks']}
        </span>
        <span class="customize-particle-chip-label">${p.name}</span>
      </button>
    `).join('')
    this.particleRowEl.querySelectorAll<HTMLButtonElement>('.customize-particle-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset['index'])
        if (Number.isFinite(idx)) this.callbacks.onSelectParticle(idx)
      })
    })
  }

  // ── Open / close ──────────────────────────────────────────────────────
  private toggle(): void {
    this.isOpen ? this.close() : this.open()
  }

  private open(): void {
    if (this.isOpen) return
    this.isOpen = true
    this.trigger.classList.add('ts-pill--open')
    this.menu.classList.add('ts-popover--open')
    if (isNarrowViewport()) {
      this.menu.classList.add('popover--sheet')
      this.menu.style.top = ''
      this.menu.style.right = ''
      this.menu.style.left = ''
    } else {
      this.menu.classList.remove('popover--sheet')
      this.positionUnder()
    }
    setTimeout(() => {
      document.addEventListener('pointerdown', this.onDocPointer)
      document.addEventListener('keydown', this.onKey)
      window.addEventListener('resize', this.onResize)
    }, 0)
  }

  private close(): void {
    if (!this.isOpen) return
    this.isOpen = false
    this.trigger.classList.remove('ts-pill--open')
    this.menu.classList.remove('ts-popover--open')
    this.menu.classList.remove('popover--sheet')
    document.removeEventListener('pointerdown', this.onDocPointer)
    document.removeEventListener('keydown', this.onKey)
    window.removeEventListener('resize', this.onResize)
  }

  private positionUnder(): void {
    const rect = this.trigger.getBoundingClientRect()
    const menuW = this.menu.offsetWidth || 280
    const right = Math.max(12, window.innerWidth - rect.right)
    const top = rect.bottom + 8
    this.menu.style.right = `${right}px`
    this.menu.style.top = `${top}px`
    this.menu.style.left = ''
    const desiredLeft = window.innerWidth - right - menuW
    if (desiredLeft < 12) this.menu.style.right = `${Math.max(12, window.innerWidth - menuW - 12)}px`
  }

  // Public lookup so the App can preserve "previous" indices if it wants.
  getCurrentTheme(): number { return this.currentThemeIndex }
  getCurrentParticle(): number { return this.currentParticleIndex }
  isChordOn(): boolean { return this.chordOn }

  dispose(): void {
    this.close()
    this.trigger.remove()
    this.menu.remove()
  }
}

// `unused` reference to keep the import live for callers that don't pass it
// directly but still rely on the type narrowing of ParticleStyle.
export type { ParticleStyle }

// Convert a Pixi-style numeric color (0xRRGGBB) into a CSS hex string.
// Used to inline theme palette colours into the preview tiles.
function numToHexCss(n: number): string {
  const hex = (n & 0xffffff).toString(16).padStart(6, '0')
  return `#${hex}`
}

const ICON_CHEV = `<svg class="ts-customize-chev" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <polyline points="6 9 12 15 18 9"/>
</svg>`

// Lightweight inline SVGs that hint at each particle style's behaviour.
// All use currentColor so they pick up theme accent on hover / when active.
const PARTICLE_GLYPHS: Record<string, string> = {
  sparks: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
    <path d="M12 3v4"/><path d="M12 17v4"/><path d="M3 12h4"/><path d="M17 12h4"/>
    <path d="M5.6 5.6l2.8 2.8"/><path d="M15.6 15.6l2.8 2.8"/>
    <path d="M5.6 18.4l2.8-2.8"/><path d="M15.6 8.4l2.8-2.8"/>
  </svg>`,
  embers: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="8" cy="17" r="1.6"/>
    <circle cx="13" cy="13" r="2" opacity="0.85"/>
    <circle cx="17" cy="8" r="1.3" opacity="0.7"/>
    <circle cx="10" cy="9" r="1" opacity="0.55"/>
    <circle cx="6" cy="11" r="0.8" opacity="0.45"/>
  </svg>`,
  bloom: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
    <circle cx="12" cy="12" r="3" fill="currentColor"/>
    <circle cx="12" cy="12" r="6" opacity="0.6"/>
    <circle cx="12" cy="12" r="9.5" opacity="0.3"/>
  </svg>`,
  sparkle: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 4l1 4 4 1-4 1-1 4-1-4-4-1 4-1 1-4z"/>
    <path d="M19 14l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2z" opacity="0.7"/>
  </svg>`,
  none: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="8" opacity="0.5"/>
    <line x1="6" y1="18" x2="18" y2="6" opacity="0.7"/>
  </svg>`,
}
