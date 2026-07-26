import { afterEach, describe, expect, it, vi } from 'vitest'

import { AE_EXECUTIVE_TABS } from '@/app/ae-executive/contract'

import {
  dispatchVoiceDevControl,
  executeVoiceDevControlIntent,
  matchVoiceDevControl,
  onVoiceDevControlIntent,
  type VoiceDevControlIntent
} from './dev-control'

describe('voice-first developer Twitch', () => {
  it.each(AE_EXECUTIVE_TABS)('derives exact navigation phrases for $label', tab => {
    const name = tab.label.replaceAll('[', '').replaceAll(']', '')

    expect(matchVoiceDevControl(`open ${name}`)).toEqual({
      schema: 'hermes-dev-control-intent/1',
      lane: 'twitch',
      action: 'navigate',
      phrase_id: `nav.${tab.id}.open`,
      route: tab.route
    })
    const show = matchVoiceDevControl(`show ${name.toLowerCase()}!`)
    expect(show?.action === 'navigate' ? show.route : null).toBe(tab.route)
  })

  it('normalizes whitespace and punctuation but does not fuzzy-match or infer', () => {
    const market = matchVoiceDevControl('  GO   TO: marketplace.  ')
    expect(market?.action === 'navigate' ? market.route : null).toBe('/ae/marketplace')
    expect(matchVoiceDevControl('show me the logs')).toBeNull()
    expect(matchVoiceDevControl('build the desktop')).toBeNull()
    expect(matchVoiceDevControl('run whatever tests are needed')).toBeNull()
    expect(matchVoiceDevControl('open the pod bay doors')).toBeNull()
  })

  it.each([
    ['show terminal', 'view.showTerminal'],
    ['open files', 'view.showFiles'],
    ['open command palette', 'nav.commandPalette']
  ] as const)('maps %s to an existing registered view action', (phrase, actionId) => {
    expect(matchVoiceDevControl(phrase)).toMatchObject({ action: 'invoke', action_id: actionId, lane: 'twitch' })
  })

  it('executes invoke intents only through the registered keybind event seam', () => {
    const actions: string[] = []
    window.addEventListener('hermes:keybind-action', event => actions.push((event as CustomEvent<string>).detail), {
      once: true
    })
    const intent = matchVoiceDevControl('show terminal')!

    expect(executeVoiceDevControlIntent(intent, vi.fn())).toBe(true)
    expect(actions).toEqual(['view.showTerminal'])
  })

  it('dispatches only a closed content-free intent and reports a local hit', () => {
    const seen: VoiceDevControlIntent[] = []
    const dispose = onVoiceDevControlIntent(intent => seen.push(intent))

    expect(dispatchVoiceDevControl('show marketplace')).toBe(true)
    expect(dispatchVoiceDevControl('explain marketplace architecture')).toBe(false)
    expect(seen).toEqual([
      {
        schema: 'hermes-dev-control-intent/1',
        lane: 'twitch',
        action: 'navigate',
        phrase_id: 'nav.marketplace.show',
        route: '/ae/marketplace'
      }
    ])
    expect(JSON.stringify(seen)).not.toContain('show marketplace')
    dispose()
  })

  it('rejects forged event details outside the current derived registry', () => {
    const listener = vi.fn()
    const dispose = onVoiceDevControlIntent(listener)

    window.dispatchEvent(
      new CustomEvent('hermes:voice-dev-control', {
        detail: {
          schema: 'hermes-dev-control-intent/1',
          lane: 'twitch',
          action: 'navigate',
          phrase_id: 'nav.escape.open',
          route: 'file:///etc/passwd'
        }
      })
    )
    expect(listener).not.toHaveBeenCalled()

    window.dispatchEvent(
      new CustomEvent('hermes:voice-dev-control', {
        detail: {
          schema: 'hermes-dev-control-intent/1',
          lane: 'twitch',
          action: 'invoke',
          phrase_id: 'dev.shell.run',
          action_id: 'terminal.exec'
        }
      })
    )
    expect(listener).not.toHaveBeenCalled()
    dispose()
  })
})

afterEach(() => vi.restoreAllMocks())
