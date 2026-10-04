import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { NavLink, useLocation } from 'react-router'
import { cn } from '@/lib/utils'

export interface NavTab {
  to: string
  label: ReactNode
  /** Only active on exactly this path (for an index tab). */
  end?: boolean
}

/**
 * Links styled as tabs. The underline slides to the active tab with a spring.
 * It is positioned straight from the DOM, without a re-render.
 */
export function NavTabs({ tabs, label }: { tabs: NavTab[]; label: string }) {
  const listRef = useRef<HTMLDivElement>(null)
  const { pathname } = useLocation()

  useLayoutEffect(() => {
    const list = listRef.current
    const active = list?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!list) return
    list.style.setProperty('--tab-x', `${active?.offsetLeft ?? 0}px`)
    list.style.setProperty('--tab-w', `${active?.offsetWidth ?? 0}px`)
    // No slide on the first placement, only between tabs.
    requestAnimationFrame(() => {
      list.dataset.ready = ''
    })
  }, [pathname])

  return (
    <nav aria-label={label} className="shrink-0 overflow-x-auto border-b px-2">
      <div ref={listRef} className="group/tabs relative flex w-max gap-1">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) =>
              cn(
                'pressable rounded-md px-3 py-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
              )
            }
          >
            {tab.label}
          </NavLink>
        ))}
        <span
          aria-hidden
          className="absolute bottom-0 left-0 h-0.5 w-(--tab-w) translate-x-(--tab-x) rounded-full bg-primary group-data-ready/tabs:transition-[translate,width] group-data-ready/tabs:motion-spring"
        />
      </div>
    </nav>
  )
}
