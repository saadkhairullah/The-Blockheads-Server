let sharedTail: Promise<unknown> = Promise.resolve()

export const enqueueShared = <T>(task: () => Promise<T> | T): Promise<T> => {
  const next = sharedTail.then(task, task)
  sharedTail = next.then(() => undefined, () => undefined)
  return next
}
