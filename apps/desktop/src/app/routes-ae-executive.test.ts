import { describe, expect, it } from 'vitest'

import { AE_EXECUTIVE_TABS } from './ae-executive/contract'
import { appViewForPath, routeSessionId } from './routes'

describe('AE executive route classification', () => {
  it.each(AE_EXECUTIVE_TABS)('classifies $route as an executive page, never a session', tab => {
    expect(appViewForPath(tab.route)).toBe('ae-executive')
    expect(routeSessionId(tab.route)).toBeNull()
  })
})
