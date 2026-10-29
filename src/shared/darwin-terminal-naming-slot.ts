let namingInFlight: Promise<unknown> | null = null

/** One /dev naming pass at a time: aborted lstat/opendir calls hold libuv pool threads until they drain. Null while one drains. */
export function claimDarwinTerminalNaming<T>(name: () => Promise<T>): Promise<T> | null {
  if (namingInFlight) {
    return null
  }
  const pending = name()
  namingInFlight = pending
  const release = (): void => {
    if (namingInFlight === pending) {
      namingInFlight = null
    }
  }
  void pending.then(release, release)
  return pending
}

export function isDarwinTerminalNamingInFlight(): boolean {
  return namingInFlight !== null
}

export function resetDarwinTerminalNamingForTests(): void {
  namingInFlight = null
}
