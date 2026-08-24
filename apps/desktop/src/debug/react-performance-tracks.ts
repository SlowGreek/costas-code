interface ConsoleWithTimeStamp {
  timeStamp?: ((label?: string) => void) | undefined
}

export function disableReactPerformanceTracks(consoleLike: ConsoleWithTimeStamp = globalThis.console): void {
  consoleLike.timeStamp = undefined
}
