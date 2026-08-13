import { resolveEpIcon } from '@/lib/icon-map'

/**
 * Render a Tabler icon from an Element Plus icon name (aligned with components/ElSvgIcon.vue).
 * props: name (EP name), size (px), color.
 */
export interface ElSvgIconProps {
  name?: string
  size?: number
  color?: string
}

export default function ElSvgIcon({ name = 'Fold', size = 18, color }: ElSvgIconProps) {
  const Icon = resolveEpIcon(name)
  return <Icon size={size} color={color || undefined} stroke={1.6} />
}
