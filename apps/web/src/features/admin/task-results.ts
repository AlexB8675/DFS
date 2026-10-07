import { ADMIN_TASK_LABELS, type AdminTask } from '@dfs/shared'
import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { afterTask, isFinished } from './api'

// Following the tasks the leading bot runs for admins (§9), on any admin page
// that starts them.

export function taskLabel(task: AdminTask): string {
  return ADMIN_TASK_LABELS[task.kind]
}

/** Says how each task seen under way ended, once it does, and refreshes what it may have changed. */
export function useTaskResults(tasks: AdminTask[] | undefined): void {
  const underWay = useRef(new Set<string>())
  useEffect(() => {
    let finished = false
    for (const task of tasks ?? []) {
      if (!isFinished(task)) {
        underWay.current.add(task.id)
        continue
      }
      if (!underWay.current.delete(task.id)) continue
      finished = true
      const label = taskLabel(task)
      if (task.state === 'done') toast.success(label, { description: task.result })
      else toast.error(`${label} failed`, { description: task.result })
    }
    if (finished) void afterTask()
  }, [tasks])
}
