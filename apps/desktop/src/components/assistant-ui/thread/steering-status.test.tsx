import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'

import { SteeringStatus } from './steering-status'

afterEach(cleanup)
it('distinguishes accepted waiting input from committed context', () => {
  const { rerender } = render(<SteeringStatus status="pending" />)
  expect(screen.getByRole('status').textContent).toMatch(/Pending/)
  rerender(<SteeringStatus status="committed" />)
  expect(screen.getByRole('status').textContent).toMatch(/context/)
})
it('never claims uncertain or cancelled delivery was accepted', () => {
  const { rerender } = render(<SteeringStatus status="unknown" />)
  expect(screen.getByRole('status').textContent).toMatch(/unknown/)
  rerender(<SteeringStatus status="cancelled" />)
  expect(screen.getByRole('status').textContent).toMatch(/Cancelled/)
})
