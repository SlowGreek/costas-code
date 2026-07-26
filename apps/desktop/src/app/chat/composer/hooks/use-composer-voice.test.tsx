// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { onVoiceDevControlIntent } from '@/lib/voice/dev-control'

import { useComposerVoice } from './use-composer-voice'

const transcribe = vi.fn()

vi.mock('./use-voice-recorder', () => ({
  useVoiceRecorder: ({ onTranscript }: { onTranscript: (text: string) => void }) => ({
    dictate: () => onTranscript(''),
    voiceActivityState: { elapsedSeconds: 0, level: 0, status: 'idle' },
    voiceStatus: 'idle'
  })
}))

vi.mock('./use-voice-conversation', () => ({
  useVoiceConversation: ({
    onSubmit
  }: {
    onSubmit: (text: string) => Promise<'local' | 'submitted'>
  }) => ({
    end: vi.fn(),
    muted: false,
    start: vi.fn(),
    status: 'idle',
    stopTurn: vi.fn(),
    submitForTest: onSubmit,
    toggleMute: vi.fn()
  })
}))

vi.mock('./use-auto-speak-replies', () => ({ useAutoSpeakReplies: vi.fn() }))

describe('voice developer-control split', () => {
  const setup = () => {
    const onSubmit = vi.fn(async () => true)

    const hook = renderHook(() =>
      useComposerVoice({
        busy: false,
        clearDraft: vi.fn(),
        disabled: false,
        focusInput: vi.fn(),
        insertText: vi.fn(),
        maxRecordingSeconds: 60,
        onSubmit,
        onTranscribeAudio: transcribe,
        sessionId: 'session-1',
        target: 'main'
      })
    )

    return { hook, onSubmit }
  }

  it('consumes an exact Twitch hit locally without creating a chat turn', async () => {
    const seen: string[] = []

    const dispose = onVoiceDevControlIntent(intent => {
      if (intent.action === 'navigate') {
        seen.push(intent.route)
      }
    })

    const { hook, onSubmit } = setup()

    await act(async () => {
      await expect(
        (
          hook.result.current.conversation as unknown as {
            submitForTest: (text: string) => Promise<'local' | 'submitted'>
          }
        ).submitForTest('show marketplace')
      ).resolves.toBe('local')
    })

    expect(seen).toEqual(['/ae/marketplace'])
    expect(onSubmit).not.toHaveBeenCalled()
    dispose()
  })

  it('falls through unchanged to Butler on a codebook miss', async () => {
    const { hook, onSubmit } = setup()

    await act(async () => {
      await expect(
        (
          hook.result.current.conversation as unknown as {
            submitForTest: (text: string) => Promise<'local' | 'submitted'>
          }
        ).submitForTest('review the rich twitch architecture')
      ).resolves.toBe('submitted')
    })

    expect(onSubmit).toHaveBeenCalledWith('review the rich twitch architecture')
  })
})

afterEach(() => vi.clearAllMocks())
