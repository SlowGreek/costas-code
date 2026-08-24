import { describe, expect, it, vi } from 'vitest'

import { disableReactPerformanceTracks } from './react-performance-tracks'

describe('disableReactPerformanceTracks', () => {
  it('removes the console capability React uses to enable development performance tracks', () => {
    const timeStamp = vi.fn()
    const consoleLike = { timeStamp }

    disableReactPerformanceTracks(consoleLike)

    expect(consoleLike.timeStamp).toBeUndefined()
    expect(timeStamp).not.toHaveBeenCalled()
  })
})
