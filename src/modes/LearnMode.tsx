import { onCleanup, onMount } from 'solid-js'
import { useApp } from '../store/AppCtx'

// Learn mode shell. LearnController holds long-lived state (hub, progress,
// runner, overlay) and stays reachable from App's DropZone for Learn file /
// sample loads. LearnHub and exercise UIs are Solid-ported; this component
// only wires lifecycle: onMount → controller.enter(), onCleanup → exit().
export function LearnMode() {
  const { learnController } = useApp()
  onMount(() => learnController.enter())
  onCleanup(() => learnController.exit())
  return null
}
