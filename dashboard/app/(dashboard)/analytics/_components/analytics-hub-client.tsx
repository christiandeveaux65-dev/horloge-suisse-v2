'use client'

import { useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import useSWR from 'swr'
import { fetcher } from '@/lib/fetcher'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PageTitle, EmptyBlock, TrendPill } from '@/components/dashboard/widgets'
import { MultiLine } from '@/components/charts'
import { toNum, periodLabel } from '@/lib/format'
import { BarChart3, Activity, FlaskConical, Scale } from 'lucide-react'
import { AnalyticsClient } from './analytics-client'
import { BacktestingClient } from '../../backtesting/_components/backtesting-client'

const VALID = ['performance', 'backtesting', 'buyhold']

function BuyHoldView() {
  const { data: history } = useSWR<{ t: number; total: number }[]>('/api/portfolio-history?hours=720', fetcher)
  const { data: weth } = useSWR<any[]>('/api/price-history?token=WETH&hours=720', fetcher)
  const { data: wbtc } = useSWR<any[]>('/api/price-history?token=WBTC&hours=720', fetcher)

  const { data, span, perf } = useMemo(() => {
    const hist = history ?? []
    if (hist.length < 2) return { data: [] as any[], span: 0, perf: null as any }
    const base = toNum(hist[0]?.total)
    const nearest = (series: any[], t: number) => {
      let best: any = null
      let bestDiff = Infinity
      for (const p of series ?? []) {
        const diff = Math.abs(toNum(p?.t) - t)
        if (diff < bestDiff) { bestDiff = diff; best = p }
      }
      return best && bestDiff < 2 * 3600_000 ? toNum(best.price) : null
    }
    const wethBase = nearest(weth ?? [], toNum(hist[0]?.t))
    const wbtcBase = nearest(wbtc ?? [], toNum(hist[0]?.t))
    const pts = hist.map((p) => {
      const t = toNum(p?.t)
      const wp = wethBase ? nearest(weth ?? [], t) : null
      const bp = wbtcBase ? nearest(wbtc ?? [], t) : null
      return {
        label: new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }).format(new Date(t)),
        bot: base > 0 ? +(100 * (toNum(p?.total) / base)).toFixed(2) : null,
        weth: wp && wethBase ? +(100 * (wp / wethBase)).toFixed(2) : null,
        wbtc: bp && wbtcBase ? +(100 * (bp / wbtcBase)).toFixed(2) : null,
      }
    })
    const spanH = Math.max(1, Math.round((toNum(hist[hist.length - 1]?.t) - toNum(hist[0]?.t)) / 3_600_000))
    const last = pts[pts.length - 1]
    return {
      data: pts,
      span: spanH,
      perf: {
        bot: (last?.bot ?? 100) - 100,
        weth: last?.weth != null ? last.weth - 100 : null,
        wbtc: last?.wbtc != null ? last.wbtc - 100 : null,
      },
    }
  }, [history, weth, wbtc])

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="glow-card border-border/60"><CardContent className="pt-5"><p className="text-xs text-muted-foreground mb-1">Bot (portefeuille réel)</p>{perf ? <TrendPill value={perf.bot} /> : <span className="text-muted-foreground text-sm">—</span>}</CardContent></Card>
        <Card className="glow-card border-border/60"><CardContent className="pt-5"><p className="text-xs text-muted-foreground mb-1">Buy & Hold WETH</p>{perf?.weth != null ? <TrendPill value={perf.weth} /> : <span className="text-muted-foreground text-sm">—</span>}</CardContent></Card>
        <Card className="glow-card border-border/60"><CardContent className="pt-5"><p className="text-xs text-muted-foreground mb-1">Buy & Hold WBTC</p>{perf?.wbtc != null ? <TrendPill value={perf.wbtc} /> : <span className="text-muted-foreground text-sm">—</span>}</CardContent></Card>
      </div>
      <Card className="glow-card border-border/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Bot vs Buy & Hold (base 100)</CardTitle>
          {span > 0 && <p className="text-xs text-muted-foreground">Données réelles disponibles sur {periodLabel(span)}</p>}
        </CardHeader>
        <CardContent>
          {(data ?? []).length > 1 ? (
            <MultiLine
              data={data}
              series={[
                { key: 'bot', color: '#2dd4a7', label: 'Bot' },
                { key: 'weth', color: '#627eea', label: 'B&H WETH' },
                { key: 'wbtc', color: '#f7931a', label: 'B&H WBTC' },
              ]}
              height={320}
            />
          ) : (
            <EmptyBlock message="Pas encore assez d'historique pour comparer." />
          )}
        </CardContent>
      </Card>
    </div>
  )
}

export function AnalyticsHubClient() {
  const params = useSearchParams()
  const initial = params?.get('tab') ?? 'performance'
  const [tab, setTab] = useState(VALID.includes(initial) ? initial : 'performance')

  return (
    <div className="space-y-6">
      <PageTitle title="Analytics" description="Performance, backtesting et comparaison Buy & Hold" icon={BarChart3} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap h-auto" aria-label="Sections de la page analytics">
          <TabsTrigger value="performance" className="gap-1.5"><Activity className="h-3.5 w-3.5" /> Performance</TabsTrigger>
          <TabsTrigger value="backtesting" className="gap-1.5"><FlaskConical className="h-3.5 w-3.5" /> Backtesting</TabsTrigger>
          <TabsTrigger value="buyhold" className="gap-1.5"><Scale className="h-3.5 w-3.5" /> Buy & Hold</TabsTrigger>
        </TabsList>
        <TabsContent value="performance" className="mt-4"><AnalyticsClient embedded /></TabsContent>
        <TabsContent value="backtesting" className="mt-4"><BacktestingClient embedded /></TabsContent>
        <TabsContent value="buyhold" className="mt-4"><BuyHoldView /></TabsContent>
      </Tabs>
    </div>
  )
}
