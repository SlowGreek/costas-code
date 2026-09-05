import { expect, test } from './test'
import { setupMockBackend, waitForAppReady, type MockBackendFixture } from './fixtures'

const INITIAL = 'E2E_STEERING_V2_HOLD: inspect only'
const CORRECTION = 'Now report the staging result without changing any files.'
const SURFACE = '[data-composer-target]:not([data-pane-hidden] [data-composer-target])'

// Real Electron + gateway + agent loop, with only the inference endpoint local.
test('steer stays pending during a live response and reaches the next request once', async () => {
  let fixture: MockBackendFixture | undefined
  try {
    fixture = await setupMockBackend({mockServer: {holdFirstStreamForPrompt: 'E2E_STEERING_V2_HOLD'}})
    await waitForAppReady(fixture, 120_000)
    const {page, mock} = fixture
    const surface = page.locator(SURFACE).last()
    const composer = surface.locator('[contenteditable="true"]').first()
    await composer.fill(INITIAL)
    await page.keyboard.press('Enter')
    await mock.waitForHeldStream()
    await composer.fill(CORRECTION)
    await surface.locator('[data-slot="composer-root"] button[type="submit"]').click()
    await expect(surface.getByText('Pending · next model request', {exact:true})).toBeVisible()
    expect(mock.receivedPrompts.filter(p => p === CORRECTION)).toHaveLength(0)
    mock.releaseHeldStream()
    await expect.poll(() => mock.receivedPrompts.filter(p => p === CORRECTION).length).toBe(1)
    await expect(surface.getByText('In model context', {exact:true})).toBeVisible()
  } finally {
    fixture?.mock.releaseHeldStream()
    await fixture?.cleanup()
  }
})
