import { onCleanup, onMount } from 'solid-js'
import { useApp } from '../store/AppCtx'

// Learn mode shell. LearnController holds all the long-lived state (hub,
// progress, runner, overlay layer) because it survives mount/unmount
// cycles and is reachable from App's DropZone callbacks for the Learn
// file/sample loaders. <LearnMode/>'s job is purely lifecycle:
// onMount → controller.enter(), onCleanup → controller.exit(). When T12
// ports LearnHub and T13/T14 port exercises, the controller's body will
// dissolve into this component + dedicated hub/exercise components.
export function LearnMode() {
  const { learnController } = useApp()
  onMount(() => learnController.enter())
  onCleanup(() => learnController.exit())
  return null
}
