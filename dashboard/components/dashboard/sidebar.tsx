'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import {
  LayoutDashboard,
  CandlestickChart,
  BarChart3,
  BrainCircuit,
  ShieldAlert,
  TrendingUp,
} from 'lucide-react'

export const NAV_ITEMS = [
  { href: '/', label: 'Tableau de bord', icon: LayoutDashboard },
  { href: '/trading', label: 'Trading', icon: CandlestickChart },
  { href: '/analytics', label: 'Analytics', icon: BarChart3 },
  { href: '/strategies', label: 'Stratégies', icon: BrainCircuit },
  { href: '/risque', label: 'Risque', icon: ShieldAlert },
]

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()

  return (
    <div className="flex h-full flex-col bg-[#0c0e15] border-r border-border/60">
      <div className="flex items-center gap-3 px-5 py-5 border-b border-border/60">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 border border-primary/30">
          <TrendingUp className="h-5 w-5 text-primary" />
        </div>
        <div>
          <p className="font-display font-bold text-base leading-none tracking-tight">PnL Maker</p>
          <p className="text-[11px] text-muted-foreground mt-1">Bot DCA + Momentum</p>
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1" aria-label="Navigation principale">
        {NAV_ITEMS.map((item) => {
          const Icon = item?.icon
          const active = item?.href === '/' ? pathname === '/' : pathname?.startsWith(item?.href ?? '')
          return (
            <Link
              key={item?.href}
              href={item?.href ?? '/'}
              onClick={() => onNavigate?.()}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200',
                active
                  ? 'bg-primary/10 text-primary border border-primary/25 glow-green'
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary/70 border border-transparent'
              )}
            >
              {Icon ? <Icon className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
              {item?.label}
            </Link>
          )
        })}
      </nav>
      <div className="px-5 py-4 border-t border-border/60">
        <p className="text-[11px] text-muted-foreground">© 2026 PnL Maker</p>
      </div>
    </div>
  )
}
