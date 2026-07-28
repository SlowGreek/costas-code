import { cn } from '@/lib/utils'

const assetPath = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`

// Brand badge: the Catalyst chevron mark, identical in light/dark.
// The artwork carries its own dark rounded tile, so no background is applied.
// Fills the tile; size via className (default size-14).
export function BrandMark({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn('inline-flex size-14 shrink-0 items-center justify-center overflow-hidden', className)}
      {...props}
    >
      <img alt="" className="size-full object-contain" src={assetPath('catalyst-icon.svg')} />
    </span>
  )
}
