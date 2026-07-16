'use client'

import useSWR from 'swr'
import { fetcher } from '@/lib/fetcher'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { StatusBadge, ChainBadge, PnlText, LoadingBlock, EmptyBlock, PageTitle, StatCard } from '@/components/dashboard/widgets'
import { fmtUsd, fmtNum, fmtDate, toNum } from '@/lib/format'
import { Layers, TrendingUp, Target } from 'lucide-react'
import type { Position, Signal } from '@/lib/types'

export function PositionsClient({ embedded = false }: { embedded?: boolean } = {}) {
  const { data: positions, isLoading } = useSWR<Position[]>('/api/bot/positions', fetcher, { refreshInterval: 60000 })
  const { data: signals } = useSWR<Signal[]>('/api/bot/signals', fetcher, { refreshInterval: 60000 })
  const { data: configs } = useSWR<any[]>('/api/bot/momentum-config', fetcher)

  // Prix actuel : fourni directement par l'API du bot, fallback sur les signaux
  const priceOf = (p?: Position | null) => {
    const direct = toNum(p?.current_price)
    if (direct > 0) return direct
    const s = (signals ?? []).find((x) => x?.token === p?.token)
    return s?.latest_price ?? 0
  }
  const configOf = (id?: string | null) => (configs ?? []).find((c) => c?.id === id)

  const open = (positions ?? []).filter((p) => p?.status === 'open')
  const closed = (positions ?? []).filter((p) => p?.status !== 'open')

  const totalCost = open.reduce((a, p) => a + toNum(p?.cost_usd), 0)
  const totalCurrent = open.reduce((a, p) => a + toNum(p?.amount_token) * priceOf(p), 0)
  const totalPnlUsd = open.reduce((a, p) => a + (p?.unrealized_pnl_usd != null ? toNum(p?.unrealized_pnl_usd) : toNum(p?.amount_token) * priceOf(p) - toNum(p?.cost_usd)), 0)
  const totalPnlPct = totalCost > 0 ? (totalPnlUsd / totalCost) * 100 : 0

  const renderTable = (rows: Position[], isOpen: boolean) =>
    (rows ?? []).length > 0 ? (
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Token</TableHead>
              <TableHead>Chain</TableHead>
              <TableHead className="text-right">Quantité</TableHead>
              <TableHead className="text-right">Prix d'entrée</TableHead>
              <TableHead className="text-right">Prix actuel</TableHead>
              <TableHead className="text-right">Coût</TableHead>
              <TableHead className="text-right">PnL</TableHead>
              <TableHead>SL / TP</TableHead>
              <TableHead>Ouverte le</TableHead>
              <TableHead>Statut</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((p) => {
              const cur = priceOf(p)
              const entry = toNum(p?.entry_price)
              const pnlPct = p?.unrealized_pnl_pct != null ? toNum(p?.unrealized_pnl_pct) : entry > 0 && cur > 0 ? ((cur - entry) / entry) * 100 : 0
              const cfg = configOf(p?.config_id)
              const tps = (cfg?.take_profit_levels ?? '').split(',').filter(Boolean)
              const hits = (p?.tp_hits ?? '').split(',').filter(Boolean)
              return (
                <TableRow key={p?.id}>
                  <TableCell className="font-semibold">{p?.token}</TableCell>
                  <TableCell><ChainBadge chain={p?.chain} /></TableCell>
                  <TableCell className="text-right font-mono">{fmtNum(p?.amount_token)}</TableCell>
                  <TableCell className="text-right font-mono">{fmtUsd(p?.entry_price)}</TableCell>
                  <TableCell className="text-right font-mono">{cur > 0 ? fmtUsd(cur) : '—'}</TableCell>
                  <TableCell className="text-right font-mono">{fmtUsd(p?.cost_usd)}</TableCell>
                  <TableCell className="text-right">{isOpen && cur > 0 ? <PnlText value={pnlPct} /> : '—'}</TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    <span className="text-loss">SL -{cfg?.stop_loss_pct ?? '?'} %</span>
                    <span className="text-muted-foreground"> · </span>
                    <span className="text-gain">TP {tps.length > 0 ? tps.map((t: string) => `+${t}%`).join(' / ') : '—'}</span>
                    {hits.length > 0 ? <span className="text-muted-foreground"> ({hits.length} atteint(s))</span> : null}
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-nowrap">{fmtDate(p?.opened_at)}</TableCell>
                  <TableCell><StatusBadge status={p?.status} /></TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    ) : (
      <EmptyBlock message={isOpen ? 'Aucune position ouverte.' : 'Aucune position fermée.'} />
    )

  return (
    <div className="space-y-6">
      {!embedded && <PageTitle title="Positions momentum" description="Positions ouvertes et fermées du moteur momentum" icon={Layers} />}

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard title="Positions ouvertes" value={`${open?.length ?? 0}`} icon={Layers} delay={0} />
        <StatCard title="Valeur actuelle" value={fmtUsd(totalCurrent)} sub={`Coût : ${fmtUsd(totalCost)}`} icon={Target} delay={0.05} />
        <StatCard title="PnL latent" value={<PnlText value={totalPnlPct} className="text-2xl" />} sub={fmtUsd(totalPnlUsd)} icon={TrendingUp} delay={0.1} />
      </div>

      <Card className="glow-card border-border/60">
        <CardHeader className="pb-2"><CardTitle className="text-base">Liste des positions</CardTitle></CardHeader>
        <CardContent>
          {isLoading ? (
            <LoadingBlock rows={6} />
          ) : (
            <Tabs defaultValue="open">
              <TabsList aria-label="Filtrer les positions par statut">
                <TabsTrigger value="open">Ouvertes ({open?.length ?? 0})</TabsTrigger>
                <TabsTrigger value="closed">Fermées ({closed?.length ?? 0})</TabsTrigger>
              </TabsList>
              <TabsContent value="open">{renderTable(open, true)}</TabsContent>
              <TabsContent value="closed">{renderTable(closed, false)}</TabsContent>
            </Tabs>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
