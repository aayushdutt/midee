import { For, Show } from 'solid-js'
import { t } from '../i18n'
import type { KeyLights, KeyLightsSettings as Settings } from '../midi/KeyLights'
import type { MidiInputManager } from '../midi/MidiInputManager'

export function KeyLightsSettings(props: { lights: KeyLights; midiInput: MidiInputManager }) {
  const available = () => props.midiInput.status.value !== 'unavailable'
  return (
    <div class="customize-section key-lights-settings">
      <div class="customize-section-head">
        <span class="customize-section-label">{t('keyLights.title')}</span>
      </div>
      <p class="customize-toggle-sub">{t('keyLights.description')}</p>
      <Show when={available()} fallback={<p role="status">{t('keyLights.unavailable')}</p>}>
        <Show when={!props.midiInput.midiAccess.value}>
          <button
            class="customize-locale-chip"
            type="button"
            onClick={() => void props.midiInput.requestAccess()}
          >
            {t('keyLights.connect')}
          </button>
          <Show when={props.midiInput.status.value === 'blocked'}>
            <p role="status">{t('keyLights.blocked')}</p>
          </Show>
        </Show>
        <label class="key-lights-field">
          <span>{t('keyLights.device')}</span>
          <select
            disabled={!props.midiInput.midiAccess.value}
            value={props.lights.settings.value.outputId}
            onChange={(event) => props.lights.configure({ outputId: event.currentTarget.value })}
          >
            <option value="" selected={!props.lights.settings.value.outputId}>
              {t('keyLights.off')}
            </option>
            <Show
              when={
                props.lights.settings.value.outputId &&
                !props.lights.outputs.value.some(
                  (output) => output.id === props.lights.settings.value.outputId,
                )
              }
            >
              <option value={props.lights.settings.value.outputId} selected>
                {t('keyLights.disconnected')}
              </option>
            </Show>
            <For each={props.lights.outputs.value}>
              {(output) => (
                <option
                  value={output.id}
                  selected={props.lights.settings.value.outputId === output.id}
                >
                  {output.name}
                </option>
              )}
            </For>
          </select>
        </label>
        <Show when={props.midiInput.midiAccess.value && props.lights.outputs.value.length === 0}>
          <p role="status">{t('keyLights.noDevices')}</p>
        </Show>
        <Show when={props.lights.status.value === 'error'}>
          <p role="status">{t('keyLights.error')}</p>
        </Show>
        <Show when={props.lights.settings.value.outputId}>
          <label class="key-lights-field">
            <span>{t('keyLights.colors')}</span>
            <select
              value={props.lights.settings.value.channelMode}
              onChange={(event) =>
                props.lights.configure({
                  channelMode: event.currentTarget.value as Settings['channelMode'],
                })
              }
            >
              <option value="original">{t('keyLights.original')}</option>
              <option value="synthesia">{t('keyLights.synthesia')}</option>
              <option value="track">{t('keyLights.track')}</option>
              <option value="single">{t('keyLights.single')}</option>
            </select>
          </label>
          <Show when={props.lights.settings.value.channelMode === 'single'}>
            <label class="key-lights-field">
              <span>{t('keyLights.channel')}</span>
              <select
                value={props.lights.settings.value.channel}
                onChange={(event) =>
                  props.lights.configure({ channel: Number(event.currentTarget.value) })
                }
              >
                <For each={Array.from({ length: 16 }, (_, i) => i + 1)}>
                  {(channel) => <option value={channel}>{channel}</option>}
                </For>
              </select>
            </label>
          </Show>
          <p class="customize-toggle-sub">{t('keyLights.colorHint')}</p>
        </Show>
        <details class="key-lights-help">
          <summary>{t('keyLights.setupHelp')}</summary>
          <div class="key-lights-help-body">
            <p class="customize-toggle-sub">{t('keyLights.keeziHint')}</p>
            <Show when={props.lights.settings.value.channelMode === 'synthesia'}>
              <p class="customize-toggle-sub">{t('keyLights.synthesiaHint')}</p>
            </Show>
          </div>
        </details>
      </Show>
    </div>
  )
}
