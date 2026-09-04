import { useI18n } from '@/i18n'
import type { SteeringReceipt } from '@/lib/steering-input'

export function SteeringStatus({ status }: { status?: SteeringReceipt['status'] }) {
  const { t } = useI18n()

  if (!status || !(status in t.steering)) {
    return null
  }

  return (
    <span className="px-2 py-1 text-xs text-muted-foreground" role="status">
      {t.steering[status as keyof typeof t.steering]}
    </span>
  )
}
