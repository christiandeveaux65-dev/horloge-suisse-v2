'use client'

import useSWR from 'swr'
import { fetcher } from '@/lib/fetcher'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { LoadingBlock, EmptyBlock, PageTitle, ChainBadge } from '@/components/dashboard/widgets'
import { fmtUsd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Radar, TrendingUp, TrendingDown, Minus } from 'lucide-react'
import type { Signal } from '@/lib/types'

const SIGNAL_META: Record<string, { label: string; cls: string; icon: any }> = {
  buy: { label: 'Signal d\'achat', cls: 'border-primary/50 text-primary bg-primary/10', icon: TrendingUp },
  sell: { label: 'Signal de vente', cls: 'border-red-500/50 text-red-400 bg-red-500/10', icon: TrendingDown },
  hold: { label: 'Attente', cls: 'border-muted-foreground/40 text-muted-foreground', icon: Minus },
}

export function ScannerClient({ embedded = false }: { embedded?: boolean } = {}) {
  const { data: signals, isLoading } = useSWR<Signal[]>('/api/bot/signals', fetcher, { refreshInterval: 60000 })

  return (
    <div className="space-y-6">
      {!embedded && <PageTitle title="Scanner d'opportunités" description="Signaux techniques calculés en continu par le moteur momentum" icon={Radar} />}

      {isLoading ? (
        <LoadingBlock rows={6} />
      ) : (signals ?? []).length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {(signals ?? []).map((s) => {
            const meta = SIGNAL_META[s?.signal ?? 'hold'] ?? SIGNAL_META.hold
            const Icon = meta?.icon ?? Minus
            const rsi = Math.max(0, Math.min(100, s?.rsi ?? 50))
            const trendUp = (s?.sma_short ?? 0) >= (s?.sma_long ?? 0)
            return (
              <Card key={`${s?.chain}-${s?.token}`} className="glow-card border-border/60">
                <CardContent className="p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-display text-lg font-bold">{s?.token}</span>
                      <ChainBadge chain={s?.chain} />
                    </div>
                    <Badge variant="outline" className={cn('gap-1.5', meta?.cls)}>
                      <Icon className="h-3 w-3" />
                      {meta?.label}
                    </Badge>
                  </div>
                  <p className="font-mono text-2xl font-bold">{fmtUsd(s?.latest_price)}</p>
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">RSI ({rsi < 35 ? 'survendu' : rsi > 70 ? 'suracheté' : 'neutre'})</span>
                      <span className="font-mono">{rsi.toFixed(1)}</span>
                    </div>
                    <Progress value={rsi} className="h-1.5" />
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded-lg bg-secondary/60 p-2">
                      <p className="text-muted-foreground">Tendance (SMA)</p>
                      <p className={cn('font-semibold', trendUp ? 'text-gain' : 'text-loss')}>
                        {trendUp ? 'Haussière' : 'Baissière'}
                      </p>
                    </div>
                    <div className="rounded-lg bg-secondary/60 p-2">
                      <p className="text-muted-foreground">Volatilité</p>
                      <p className="font-mono font-semibold">{((s?.volatility ?? 0) * 100).toFixed(2)} %</p>
                    </div>
                    <div className="rounded-lg bg-secondary/60 p-2">
                      <p className="text-muted-foreground">SMA courte</p>
                      <p className="font-mono">{fmtUsd(s?.sma_short)}</p>
                    </div>
                    <div className="rounded-lg bg-secondary/60 p-2">
                      <p className="text-muted-foreground">SMA longue</p>
                      <p className="font-mono">{fmtUsd(s?.sma_long)}</p>
                    </div>
                  </div>
                  <p className="text-[11px] text-muted-foreground">{s?.data_points ?? 0} points de données analysés</p>
                </CardContent>
              </Card>
            )
          })}
        </div>
      ) : (
        <EmptyBlock message="Aucun signal disponible pour le moment." />
      )}
    </div>
  )
}
