'use client'

import { useState, useMemo } from 'react'
import useSWR from 'swr'
import { fetcher } from '@/lib/fetcher'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { LoadingBlock, EmptyBlock, PageTitle } from '@/components/dashboard/widgets'
import { MultiLine } from '@/components/charts'
import { fmtUsd, fmtDate, CHAIN_LABELS, CHART_COLORS } from '@/lib/format'
import { LineChart as LineChartIcon } from 'lucide-react'

const PERIODS = [
  { value: '24', label: '24 heures' },
  { value: '72', label: '3 jours' },
  { value: '168', label: '7 jours' },
  { value: '720', label: '30 jours' },
]

export function PrixClient({ embedded = false }: { embedded?: boolean } = {}) {
  const { data: tokens } = useSWR<{ chain: string; token: string; count: number }[]>('/api/price-history?meta=tokens', fetcher)
  const [selected, setSelected] = useState<string>('__all__')
  const [hours, setHours] = useState('168')

  const tokenList = (tokens ?? []).map((t) => `${t?.chain}:${t?.token}`)

  const query =
    selected === '__all__'
      ? `/api/price-history?hours=${hours}`
      : `/api/price-history?hours=${hours}&chain=${selected?.split(':')?.[0] ?? ''}&token=${selected?.split(':')?.[1] ?? ''}`

  const { data: prices, isLoading } = useSWR<{ chain: string; token: string; price: number; t: number }[]>(query, fetcher, {
    refreshInterval: 120000,
  })

  // Normalisation en base 100 quand plusieurs tokens sont affichés
  const { chartData, series } = useMemo(() => {
    const rows = prices ?? []
    const byToken = new Map<string, { t: number; price: number }[]>()
    for (const r of rows) {
      const key = r?.token ?? '?'
      const arr = byToken.get(key) ?? []
      arr.push({ t: r?.t ?? 0, price: r?.price ?? 0 })
      byToken.set(key, arr)
    }
    const multi = byToken.size > 1
    const bucket = new Map<number, Record<string, any>>()
    const firsts = new Map<string, number>()
    byToken.forEach((arr, token) => {
      const first = arr?.[0]?.price ?? 1
      firsts.set(token, first > 0 ? first : 1)
    })
    for (const r of rows) {
      const t = Math.floor((r?.t ?? 0) / 600000) * 600000
      const row = bucket.get(t) ?? { t, label: fmtDate(t).slice(0, 5) + ' ' + fmtDate(t).slice(11) }
      const val = multi ? ((r?.price ?? 0) / (firsts.get(r?.token ?? '') ?? 1)) * 100 : r?.price ?? 0
      row[r?.token ?? '?'] = parseFloat(val.toFixed(multi ? 2 : 6))
      bucket.set(t, row)
    }
    const data = Array.from(bucket.values()).sort((a, b) => (a?.t ?? 0) - (b?.t ?? 0))
    const s = Array.from(byToken.keys()).map((token, i) => ({
      key: token,
      color: CHART_COLORS[i % CHART_COLORS.length],
      label: token,
    }))
    return { chartData: data, series: s, multi }
  }, [prices])

  const latestByToken = useMemo(() => {
    const map = new Map<string, { price: number; t: number; chain: string }>()
    for (const r of prices ?? []) {
      const cur = map.get(r?.token ?? '')
      if (!cur || (r?.t ?? 0) > (cur?.t ?? 0)) {
        map.set(r?.token ?? '', { price: r?.price ?? 0, t: r?.t ?? 0, chain: r?.chain ?? '' })
      }
    }
    return Array.from(map.entries())
  }, [prices])

  const isMulti = (series?.length ?? 0) > 1

  return (
    <div className="space-y-6">
      {!embedded && <PageTitle title="Prix & Charts" description="Historique des prix des tokens suivis par le bot" icon={LineChartIcon} />}

      <div className="flex flex-wrap gap-3">
        <Select value={selected} onValueChange={setSelected}>
          <SelectTrigger className="w-56" aria-label="Sélectionner le token à afficher">
            <SelectValue placeholder="Token" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">Tous les tokens (base 100)</SelectItem>
            {tokenList.map((t) => {
              const [chain, token] = t?.split(':') ?? []
              return (
                <SelectItem key={t} value={t}>
                  {token} · {CHAIN_LABELS[chain ?? ''] ?? chain}
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>
        <Select value={hours} onValueChange={setHours}>
          <SelectTrigger className="w-40" aria-label="Sélectionner la période">
            <SelectValue placeholder="Période" />
          </SelectTrigger>
          <SelectContent>
            {PERIODS.map((p) => (
              <SelectItem key={p?.value} value={p?.value}>
                {p?.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card className="glow-card border-border/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            {isMulti ? 'Évolution comparée (base 100)' : `Prix ${series?.[0]?.label ?? ''}`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <LoadingBlock rows={5} />
          ) : (chartData ?? []).length > 0 ? (
            <MultiLine
              data={chartData ?? []}
              series={series ?? []}
              height={380}
              yFormatter={(v: any) => (isMulti ? `${v}` : `$${Number(v ?? 0).toLocaleString('fr-FR', { maximumFractionDigits: 4 })}`)}
            />
          ) : (
            <EmptyBlock message="Aucune donnée de prix pour cette sélection." />
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {latestByToken.map(([token, info]) => (
          <Card key={token} className="glow-card border-border/60">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wider">{token} · {CHAIN_LABELS[info?.chain ?? ''] ?? info?.chain}</p>
              <p className="font-display text-xl font-bold mt-1">{fmtUsd(info?.price)}</p>
              <p className="text-[11px] text-muted-foreground mt-1">Dernière mesure : {fmtDate(info?.t)}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
