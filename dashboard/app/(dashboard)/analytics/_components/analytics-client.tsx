'use client'

import { useMemo } from 'react'
import useSWR from 'swr'
import { fetcher } from '@/lib/fetcher'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatCard, EmptyBlock, PageTitle, PnlText } from '@/components/dashboard/widgets'
import { AreaSeries, Donut, Bars } from '@/components/charts'
import { fmtDateShort, toNum } from '@/lib/format'
import { BarChart3, TrendingUp, TrendingDown, Percent, Activity } from 'lucide-react'
import type { Trade, Backtest, Portfolio } from '@/lib/types'

export function AnalyticsClient({ embedded = false }: { embedded?: boolean } = {}) {
  const { data: history } = useSWR<{ t: number; total: number }[]>('/api/portfolio-history?hours=2160', fetcher)
  const { data: tradesData } = useSWR('/api/bot/trades?limit=500', fetcher)
  const { data: backtests } = useSWR<Backtest[]>('/api/bot/backtests', fetcher)
  const { data: portfolio } = useSWR<Portfolio>('/api/bot/portfolio', fetcher)

  const trades: Trade[] = tradesData?.trades ?? []

  const kpis = useMemo(() => {
    const series = history ?? []
    // Source de vérité : pnl_summary fourni par l'API du bot (aucun recalcul côté frontend)
    const totalReturnPct = toNum(portfolio?.pnl_summary?.total_pnl_percent)

    // Max drawdown sur l'historique
    let peak = 0
    let maxDd = 0
    for (const p of series) {
      const v = p?.total ?? 0
      if (v > peak) peak = v
      if (peak > 0) maxDd = Math.max(maxDd, ((peak - v) / peak) * 100)
    }

    // Sharpe approximatif sur rendements par point (annualisé, points ~5min mais espacés : on utilise les rendements bruts)
    const rets: number[] = []
    for (let i = 1; i < series.length; i++) {
      const prev = series[i - 1]?.total ?? 0
      const cur = series[i]?.total ?? 0
      if (prev > 0) rets.push((cur - prev) / prev)
    }
    const mean = rets.length > 0 ? rets.reduce((a, b) => a + b, 0) / rets.length : 0
    const std = rets.length > 1 ? Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1)) : 0
    const periodsPerYear = (365 * 24 * 60) / 60 // ~1 point/heure effectif
    const sharpe = std > 0 ? (mean / std) * Math.sqrt(periodsPerYear) : 0

    const completed = trades.filter((t) => t?.status === 'completed').length
    const failed = trades.filter((t) => t?.status === 'failed').length
    const successRate = completed + failed > 0 ? (completed / (completed + failed)) * 100 : 0

    return { totalReturnPct, maxDd, sharpe, successRate, completed, failed }
  }, [history, portfolio, trades])

  const tradeSplit = [
    { name: 'Complétés', value: kpis?.completed ?? 0, color: '#2dd4a7' },
    { name: 'Échoués', value: kpis?.failed ?? 0, color: '#f87171' },
  ]

  const volumeByStrategy = useMemo(() => {
    const dca = trades.filter((t) => t?.source === 'dca' && t?.status === 'completed').reduce((a, t) => a + toNum(t?.amount_in), 0)
    const momentum = trades.filter((t) => t?.source === 'momentum' && t?.status === 'completed').reduce((a, t) => a + toNum(t?.amount_in), 0)
    return [
      { label: 'DCA', volume: parseFloat(dca.toFixed(2)) },
      { label: 'Momentum', volume: parseFloat(momentum.toFixed(2)) },
    ]
  }, [trades])

  const backtestComparison = (backtests ?? []).slice(0, 8).map((b) => ({
    label: `${b?.strategy_type === 'dca' ? 'DCA' : 'Mom.'} ${fmtDateShort(b?.created_at)}`,
    strategie: toNum(b?.total_return_pct),
    buyhold: toNum(b?.buy_hold_pct),
  }))

  return (
    <div className="space-y-6">
      {!embedded && <PageTitle title="Analytics Performance" description="Indicateurs de performance globaux et comparaisons de stratégies" icon={BarChart3} />}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Rendement total" value={<PnlText value={kpis?.totalReturnPct} className="text-2xl" />} sub="PnL global fourni par l'API du bot" icon={TrendingUp} delay={0} />
        <StatCard title="Max drawdown" value={<span className="text-loss">-{(kpis?.maxDd ?? 0).toFixed(2)} %</span>} sub="sur l'historique du portefeuille" icon={TrendingDown} delay={0.05} />
        <StatCard title="Ratio de Sharpe" value={(kpis?.sharpe ?? 0).toFixed(2)} sub="annualisé (approximation)" icon={Activity} delay={0.1} />
        <StatCard title="Taux de réussite" value={`${(kpis?.successRate ?? 0).toFixed(1)} %`} sub={`${kpis?.completed ?? 0} réussis · ${kpis?.failed ?? 0} échoués`} icon={Percent} delay={0.15} />
      </div>

      <Card className="glow-card border-border/60">
        <CardHeader className="pb-2"><CardTitle className="text-base">Évolution du portefeuille (historique complet)</CardTitle></CardHeader>
        <CardContent>
          {(history ?? []).length > 0 ? <AreaSeries data={history ?? []} height={300} /> : <EmptyBlock message="Pas encore d'historique." />}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="glow-card border-border/60">
          <CardHeader className="pb-2"><CardTitle className="text-base">Stratégie vs Buy & Hold (backtests)</CardTitle></CardHeader>
          <CardContent>
            {(backtestComparison ?? []).length > 0 ? (
              <Bars
                data={backtestComparison}
                bars={[
                  { key: 'strategie', color: '#2dd4a7', label: 'Stratégie (%)' },
                  { key: 'buyhold', color: '#38bdf8', label: 'Buy & Hold (%)' },
                ]}
                height={280}
                yFormatter={(v: any) => `${v}%`}
              />
            ) : (
              <EmptyBlock message="Lancez des backtests pour comparer les stratégies." />
            )}
          </CardContent>
        </Card>
        <Card className="glow-card border-border/60">
          <CardHeader className="pb-2"><CardTitle className="text-base">Répartition des trades</CardTitle></CardHeader>
          <CardContent>
            {(kpis?.completed ?? 0) + (kpis?.failed ?? 0) > 0 ? <Donut data={tradeSplit} height={280} /> : <EmptyBlock message="Aucun trade." />}
          </CardContent>
        </Card>
      </div>

      <Card className="glow-card border-border/60">
        <CardHeader className="pb-2"><CardTitle className="text-base">Volume traité par stratégie (USD)</CardTitle></CardHeader>
        <CardContent>
          <Bars
            data={volumeByStrategy}
            bars={[{ key: 'volume', color: '#a78bfa', label: 'Volume (USD)' }]}
            height={240}
            yFormatter={(v: any) => `$${Number(v ?? 0).toLocaleString('fr-FR')}`}
          />
        </CardContent>
      </Card>
    </div>
  )
}
