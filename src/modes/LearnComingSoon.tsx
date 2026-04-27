import { onCleanup, onMount } from 'solid-js'
import { t } from '../i18n'
import { useApp } from '../store/AppCtx'

// Marketing surface for builds without VITE_ENABLE_LEARN_MODE. Lives in the
// same overlay slot LearnHub does, so navigating to the Learn pill feels
// coherent — we just swap the surface based on the flag in ModeSwitch.
//
// Mirrors LearnController.enter()'s reset path: a Play-mode session that was
// still playing would otherwise keep the clock ticking + synth scheduling MIDI
// in the background of this surface. resetInteractionState halts everything.
export function LearnComingSoon() {
  const { services, resetInteractionState, trackPanel, dropzone } = useApp()
  onMount(() => {
    resetInteractionState()
    trackPanel.close()
    dropzone.hide()
    services.renderer.clearMidi()
    services.renderer.setLiveNotesVisible(false)
    services.renderer.setVisible(false)
    document.title = t('learn.soon.docTitle')
  })
  onCleanup(() => {
    services.renderer.setVisible(true)
    services.renderer.setLiveNotesVisible(true)
  })

  return (
    <div class="learn-soon">
      <div class="learn-soon__aurora" aria-hidden="true" />
      <div class="learn-soon__grain" aria-hidden="true" />
      <div class="learn-soon__center">
        <span class="learn-soon__badge">
          <span class="learn-soon__pulse" aria-hidden="true">
            <span class="learn-soon__pulse-dot" />
            <span class="learn-soon__pulse-ring" />
          </span>
          <span class="learn-soon__badge-text">{t('learn.soon.badge')}</span>
        </span>
        {/* biome-ignore lint/a11y/useHeadingContent: `learn.soon.title.html` is
            a translation key whose value is raw HTML — biome can't introspect
            innerHTML. Content is always present at runtime. */}
        <h1 class="learn-soon__title" innerHTML={t('learn.soon.title.html')} />
        <p class="learn-soon__sub">{t('learn.soon.body')}</p>
      </div>
    </div>
  )
}
