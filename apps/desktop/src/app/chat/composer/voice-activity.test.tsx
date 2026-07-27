import { render } from '@testing-library/react'
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Regression coverage for the CoreAudio wake-lock leak.
 *
 * A running AudioContext holds the CoreAudio output device open, which makes
 * coreaudiod assert PreventUserIdleSystemSleep against BuiltInSpeakerDevice for
 * the life of the app. The waveform renderer is the only consumer of that
 * context, so when the last renderer unmounts the context MUST be suspended.
 *
 * The context and its consumer count are module-level singletons, so each test
 * re-imports the module to get a clean lifecycle.
 */

class FakeAnalyser {
  fftSize = 2048
  smoothingTimeConstant = 0
  readonly connect = vi.fn()
  readonly disconnect = vi.fn()

  get frequencyBinCount() {
    return this.fftSize / 2
  }

  getByteFrequencyData(target: Uint8Array) {
    target.fill(0)
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []

  state: 'running' | 'suspended' | 'closed' = 'running'
  readonly destination = {}
  readonly suspend = vi.fn(async () => {
    this.state = 'suspended'
  })

  constructor() {
    FakeAudioContext.instances.push(this)
  }

  createMediaElementSource() {
    return { connect: vi.fn(), disconnect: vi.fn() }
  }

  createAnalyser() {
    return new FakeAnalyser()
  }

  async resume() {
    this.state = 'running'
  }
}

function stubCanvas2d() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    setTransform: vi.fn(),
    fillStyle: '',
    imageSmoothingEnabled: true
  } as unknown as CanvasRenderingContext2D)
}

function makeAudio(paused: boolean): HTMLAudioElement {
  // eslint-disable-next-line no-restricted-globals -- jsdom element factory in a test
  const el = document.createElement('audio')
  Object.defineProperty(el, 'paused', { configurable: true, value: paused })

  return el
}

describe('PlaybackWaveform audio context lifecycle', () => {
  beforeEach(() => {
    vi.resetModules()
    FakeAudioContext.instances = []
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  async function setup(raf: () => number = () => 1) {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('requestAnimationFrame', raf)
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    stubCanvas2d()

    const mod = await import('./voice-activity')

    return mod.PlaybackWaveform
  }

  it('suspends the shared context once the last waveform unmounts', async () => {
    const PlaybackWaveform = await setup()

    const view = render(<PlaybackWaveform audioElement={makeAudio(false)} />)
    const [context] = FakeAudioContext.instances

    assert(context, 'expected an AudioContext to be created')
    expect(context.state).toBe('running')

    view.unmount()

    expect(context.suspend).toHaveBeenCalledTimes(1)
    expect(context.state).toBe('suspended')
  })

  it('keeps the context running while another waveform is still mounted', async () => {
    const PlaybackWaveform = await setup()

    const first = render(<PlaybackWaveform audioElement={makeAudio(false)} />)
    const second = render(<PlaybackWaveform audioElement={makeAudio(false)} />)
    const [context] = FakeAudioContext.instances

    assert(context, 'expected an AudioContext to be created')

    first.unmount()
    expect(context.suspend).not.toHaveBeenCalled()
    expect(context.state).toBe('running')

    second.unmount()
    expect(context.suspend).toHaveBeenCalledTimes(1)
    expect(context.state).toBe('suspended')
  })

  it('does not spin the render loop while the element is paused', async () => {
    const raf = vi.fn(() => 1)
    const PlaybackWaveform = await setup(raf)

    render(<PlaybackWaveform audioElement={makeAudio(true)} />)

    // A paused element yields a flat spectrum forever; re-arming at 60Hz here is
    // what kept the renderer awake between utterances.
    expect(raf).not.toHaveBeenCalled()
  })
})
