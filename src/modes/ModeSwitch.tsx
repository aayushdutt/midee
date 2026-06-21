import { ErrorBoundary, Match, Switch } from 'solid-js'
import { useApp } from '../store/AppCtx'
import { HomeMode } from './HomeMode'
import { LearnMode } from './LearnMode'
import { LiveMode } from './LiveMode'
import { ModeError } from './ModeError'
import { PlayMode } from './PlayMode'

// One ErrorBoundary covers every mode — a throw in any Match branch
// renders <ModeError/> with a retry button that resets the boundary.
export function ModeSwitch() {
  const { store } = useApp()
  return (
    <ErrorBoundary fallback={(err, retry) => <ModeError err={err} onRetry={retry} />}>
      <Switch>
        <Match when={store.state.mode === 'home'}>
          <HomeMode />
        </Match>
        <Match when={store.state.mode === 'play'}>
          <PlayMode />
        </Match>
        <Match when={store.state.mode === 'live'}>
          <LiveMode />
        </Match>
        <Match when={store.state.mode === 'learn'}>
          <LearnMode />
        </Match>
      </Switch>
    </ErrorBoundary>
  )
}
