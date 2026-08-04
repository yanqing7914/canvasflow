import type { ReactNode } from 'react'
import type { ComponentSpec } from '@canvasflow/schema'

/**
 * The card shell every rendered component sits in.
 *
 * It owns the attributes the rest of the surface reads back — the component's id,
 * its type, and its parked/driving visibility — so a card only has to describe its
 * own contents. Lives on its own so cards can be split across files without one
 * importing another for the wrapper.
 */
export function ComponentSurface({
  component,
  children,
  className = '',
  role,
  data,
}: {
  component: ComponentSpec
  children: ReactNode
  className?: string
  role?: 'alert' | 'status'
  /** Extra `data-*` attributes a card wants readable from the surface. */
  data?: Record<`data-${string}`, string>
}) {
  const level = component.type === 'alert' || component.type === 'status-banner' ? component.props.level : undefined
  return (
    <article
      className={`ui-card ui-card--${component.type}${className ? ` ${className}` : ''}`}
      data-component-id={component.id}
      data-component-type={component.type}
      data-visibility={component.visibility ?? 'always'}
      data-level={level}
      role={role}
      {...data}
    >
      {children}
    </article>
  )
}
