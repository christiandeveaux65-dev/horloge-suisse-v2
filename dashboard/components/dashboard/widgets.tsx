'use client'

import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { toNum, fmtPct, CHAIN_LABELS, tokenColor } from '@/lib/format'
import { AlertTriangle, Inbox, ArrowUpRight, ArrowDownRight, Minus, type LucideIcon } from 'lucide-react'
import { motion } from 'framer-motion'

// Pastille de tendance avec flèche ↑/↓ et couleur verte/rouge
export function TrendPill({ value, suffix = ' %', className, digits = 2 }: { value: any; suffix?: string; className?: string; digits?: number }) {
  const n = toNum(value)
  const up = n > 0
  const down = n < 0
  const Icon = up ? ArrowUpRight : down ? ArrowDownRight : Minus
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-semibold font-mono',
        up ? 'bg-[#2dd4a7]/10 text-gain' : down ? 'bg-[#f87171]/10 text-loss' : 'bg-secondary text-muted-foreground',
        className
      )}
    >
      <Icon className="h-3 w-3" />
      {up ? '+' : ''}{n.toFixed(digits)}{suffix}
    </span>
  )
}

// Pastille de token avec initiale colorée
export function TokenBadge({ symbol, size = 32 }: { symbol?: string | null; size?: number }) {
  const sym = (symbol ?? '?').trim()
  const color = tokenColor(sym)
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full font-bold text-white"
      style={{ width: size, height: size, background: `${color}`, fontSize: size * 0.38, boxShadow: `0 0 12px ${color}55` }}
      title={sym}
    >
      {sym.slice(0, sym.length > 4 ? 2 : 1).toUpperCase()}
    </div>
  )
}

export function StatCard({
  title,
  value,
  sub,
  icon: Icon,
  accent = 'text-primary',
  delay = 0,
}: {
  title: string
  value: React.ReactNode
  sub?: React.ReactNode
  icon?: LucideIcon
  accent?: string
  delay?: number
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay }}
    >
      <Card className="glow-card border-border/60">
        <CardContent className="p-5">
          <div className="flex items-start justify-between">
            <div className="space-y-1.5 min-w-0">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{title}</p>
              <p className="font-display text-2xl font-bold tracking-tight truncate">{value}</p>
              {sub ? <div className="text-xs text-muted-foreground">{sub}</div> : null}
            </div>
            {Icon ? (
              <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-secondary/80', accent)}>
                <Icon className="h-4.5 w-4.5" style={{ width: 18, height: 18 }} />
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </motion.div>
  )
}

const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  completed: { label: 'Complété', cls: 'border-primary/40 text-primary bg-primary/5' },
  failed: { label: 'Échoué', cls: 'border-red-500/40 text-red-400 bg-red-500/5' },
  pending: { label: 'En attente', cls: 'border-yellow-500/40 text-yellow-400 bg-yellow-500/5' },
  active: { label: 'Actif', cls: 'border-sky-500/40 text-sky-400 bg-sky-500/5' },
  cancelled: { label: 'Annulé', cls: 'border-muted-foreground/40 text-muted-foreground' },
  open: { label: 'Ouverte', cls: 'border-primary/40 text-primary bg-primary/5' },
  closed: { label: 'Fermée', cls: 'border-muted-foreground/40 text-muted-foreground' },
}

export function StatusBadge({ status }: { status?: string | null }) {
  const s = STATUS_LABELS[status ?? ''] ?? { label: status ?? '—', cls: 'border-muted-foreground/40 text-muted-foreground' }
  return (
    <Badge variant="outline" className={cn('font-medium', s?.cls)}>
      {s?.label}
    </Badge>
  )
}

export function SideBadge({ side }: { side?: string | null }) {
  const isBuy = side === 'buy'
  return (
    <Badge
      variant="outline"
      className={cn(
        'font-medium',
        isBuy ? 'border-primary/40 text-primary bg-primary/5' : 'border-orange-500/40 text-orange-400 bg-orange-500/5'
      )}
    >
      {isBuy ? 'Achat' : 'Vente'}
    </Badge>
  )
}

export function ChainBadge({ chain }: { chain?: string | null }) {
  const colors: Record<string, string> = {
    arbitrum: 'border-sky-500/40 text-sky-400 bg-sky-500/5',
    base: 'border-primary/40 text-primary bg-primary/5',
    optimism: 'border-red-500/40 text-red-400 bg-red-500/5',
  }
  return (
    <Badge variant="outline" className={cn('font-medium capitalize', colors[chain ?? ''] ?? 'border-muted-foreground/40 text-muted-foreground')}>
      {CHAIN_LABELS[chain ?? ''] ?? chain ?? '—'}
    </Badge>
  )
}

export function PnlText({ value, suffix = '', className }: { value: any; suffix?: string; className?: string }) {
  const n = toNum(value)
  return (
    <span className={cn('font-mono font-semibold', n > 0 ? 'text-gain' : n < 0 ? 'text-loss' : 'text-muted-foreground', className)}>
      {fmtPct(n)}
      {suffix}
    </span>
  )
}

export function LoadingBlock({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3" role="status" aria-live="polite" aria-label="Chargement des données">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full rounded-lg" />
      ))}
    </div>
  )
}

export function ErrorBlock({ message }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center" role="alert">
      <AlertTriangle className="h-8 w-8 text-yellow-500" aria-hidden="true" />
      <p className="text-sm text-muted-foreground">
        {message ?? 'Impossible de charger les données. Veuillez réessayer.'}
      </p>
    </div>
  )
}

export function EmptyBlock({ message }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center" role="status" aria-live="polite">
      <Inbox className="h-8 w-8 text-muted-foreground/60" aria-hidden="true" />
      <p className="text-sm text-muted-foreground">{message ?? 'Aucune donnée disponible.'}</p>
    </div>
  )
}

export function PageTitle({ title, description, icon: Icon }: { title: string; description?: string; icon?: LucideIcon }) {
  return (
    <div className="flex items-center gap-3">
      {Icon ? (
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 border border-primary/25">
          <Icon className="h-5 w-5 text-primary" />
        </div>
      ) : null}
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
    </div>
  )
}
