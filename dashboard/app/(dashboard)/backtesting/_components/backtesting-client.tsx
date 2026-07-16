'use client'

import { useState, useMemo } from 'react'
import useSWR from 'swr'
import { fetcher } from '@/lib/fetcher'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { StatCard, LoadingBlock, EmptyBlock, PageTitle, PnlText } from '@/components/dashboard/widgets'
import { AreaSeries } from '@/components/charts'
import { fmtUsd, fmtDate, fmtPct, toNum } from '@/lib/format'
import { FlaskConical, Play, Loader2, Eye } from 'lucide-react'
import { toast } from 'sonner'
import type { Backtest } from '@/lib/types'

export function BacktestingClient({ embedded = false }: { embedded?: boolean } = {}) {
  const { data: backtests, isLoading, mutate } = useSWR<Backtest[]>('/api/bot/backtests', fetcher)
  const [running, setRunning] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const { data: detail } = useSWR<Backtest>(selectedId ? `/api/bot/backtests/${selectedId}` : null, fetcher)

  const [form, setForm] = useState({
    strategy_type: 'dca',
    chain: 'arbitrum',
    tokens: 'WETH',
    start_date: '2024-01-01',
    end_date: '2024-12-31',
    initial_capital: '10000',
  })
  const set = (k: string, v: string) => setForm({ ...(form ?? {}), [k]: v })

  const run = async (e: React.FormEvent) => {
    e.preventDefault()
    setRunning(true)
    try {
      const payload = {
        strategy_type: form?.strategy_type,
        chain: form?.chain,
        tokens: (form?.tokens ?? '').split(',').map((t) => t.trim()).filter(Boolean),
        start_date: new Date(form?.start_date ?? '').toISOString(),
        end_date: new Date(form?.end_date ?? '').toISOString(),
        initial_capital: form?.initial_capital,
      }
      const res = await fetch('/api/bot/backtests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const msg = Array.isArray(data?.message) ? data.message.join(' · ') : data?.message ?? 'Erreur lors du backtest'
        toast.error(msg)
      } else {
        toast.success('Backtest terminé')
        mutate()
        if (data?.id) setSelectedId(data.id)
      }
    } catch {
      toast.error('Erreur réseau')
    }
    setRunning(false)
  }

  const equityData = useMemo(
    () => (detail?.equity_curve ?? []).map((p) => ({ t: (p?.t ?? 0) * 1000, total: p?.equity ?? 0 })),
    [detail?.equity_curve]
  )

  return (
    <div className="space-y-6">
      {!embedded && <PageTitle title="Backtesting" description="Simulez vos stratégies sur des données historiques" icon={FlaskConical} />}

      <Card className="glow-card border-border/60">
        <CardHeader className="pb-2"><CardTitle className="text-base">Lancer un backtest</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={run} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            <div className="space-y-1.5">
              <Label>Stratégie</Label>
              <Select value={form?.strategy_type} onValueChange={(v) => set('strategy_type', v)}>
                <SelectTrigger aria-label="Stratégie à backtester"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="dca">DCA</SelectItem>
                  <SelectItem value="momentum">Momentum</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Chain</Label>
              <Select value={form?.chain} onValueChange={(v) => set('chain', v)}>
                <SelectTrigger aria-label="Réseau du backtest"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="arbitrum">Arbitrum</SelectItem>
                  <SelectItem value="base">Base</SelectItem>
                  <SelectItem value="optimism">Optimism</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Tokens (séparés par ,)</Label>
              <Input aria-label="Tokens à backtester" value={form?.tokens ?? ''} onChange={(e) => set('tokens', e?.target?.value ?? '')} placeholder="WETH,ARB" required />
            </div>
            <div className="space-y-1.5">
              <Label>Date début</Label>
              <Input type="date" aria-label="Date de début du backtest" value={form?.start_date ?? ''} onChange={(e) => set('start_date', e?.target?.value ?? '')} required />
            </div>
            <div className="space-y-1.5">
              <Label>Date fin</Label>
              <Input type="date" aria-label="Date de fin du backtest" value={form?.end_date ?? ''} onChange={(e) => set('end_date', e?.target?.value ?? '')} required />
            </div>
            <div className="space-y-1.5">
              <Label>Capital initial (USD)</Label>
              <Input type="number" min="100" aria-label="Capital initial en dollars" value={form?.initial_capital ?? ''} onChange={(e) => set('initial_capital', e?.target?.value ?? '')} required />
            </div>
            <div className="sm:col-span-2 lg:col-span-3 xl:col-span-6">
              <Button type="submit" disabled={running} aria-busy={running} className="gap-1.5">
                {running ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}
                {running ? 'Simulation en cours…' : 'Lancer le backtest'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {detail?.id ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              title="Rendement total"
              value={<PnlText value={detail?.total_return_pct} className="text-2xl" />}
              sub={`vs Buy & Hold : ${fmtPct(detail?.buy_hold_pct)}`}
              delay={0}
            />
            <StatCard title="Équité finale" value={fmtUsd(detail?.final_equity)} sub={`Capital initial : ${fmtUsd(detail?.initial_capital)}`} delay={0.05} />
            <StatCard title="Max drawdown" value={<span className="text-loss">{toNum(detail?.max_drawdown_pct).toFixed(2)} %</span>} sub={`Sharpe : ${toNum(detail?.sharpe_ratio).toFixed(2)}`} delay={0.1} />
            <StatCard title="Taux de réussite" value={`${toNum(detail?.win_rate_pct).toFixed(1)} %`} sub={`${detail?.trades_count ?? 0} trade(s) simulé(s)`} delay={0.15} />
          </div>
          <Card className="glow-card border-border/60">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                Courbe d'équité — {detail?.strategy_type === 'dca' ? 'DCA' : 'Momentum'} · {Array.isArray(detail?.tokens) ? detail?.tokens?.join(', ') : detail?.tokens}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {(equityData ?? []).length > 0 ? <AreaSeries data={equityData} height={320} color="#38bdf8" /> : <EmptyBlock message="Pas de courbe d'équité disponible." />}
            </CardContent>
          </Card>
        </div>
      ) : null}

      <Card className="glow-card border-border/60">
        <CardHeader className="pb-2"><CardTitle className="text-base">Historique des backtests</CardTitle></CardHeader>
        <CardContent>
          {isLoading ? (
            <LoadingBlock rows={5} />
          ) : (backtests ?? []).length > 0 ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Stratégie</TableHead>
                    <TableHead>Tokens</TableHead>
                    <TableHead>Période</TableHead>
                    <TableHead className="text-right">Rendement</TableHead>
                    <TableHead className="text-right">Buy & Hold</TableHead>
                    <TableHead className="text-right">Max DD</TableHead>
                    <TableHead className="text-right">Sharpe</TableHead>
                    <TableHead className="text-right">Trades</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(backtests ?? []).map((b) => (
                    <TableRow key={b?.id} className={selectedId === b?.id ? 'bg-primary/5' : ''}>
                      <TableCell className="font-mono text-xs whitespace-nowrap">{fmtDate(b?.created_at)}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={b?.strategy_type === 'dca' ? 'border-primary/40 text-primary' : 'border-sky-500/40 text-sky-400'}>
                          {b?.strategy_type === 'dca' ? 'DCA' : 'Momentum'}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{Array.isArray(b?.tokens) ? b?.tokens?.join(', ') : b?.tokens}</TableCell>
                      <TableCell className="font-mono text-xs whitespace-nowrap">{fmtDate(b?.start_date).slice(0, 10)} → {fmtDate(b?.end_date).slice(0, 10)}</TableCell>
                      <TableCell className="text-right"><PnlText value={b?.total_return_pct} /></TableCell>
                      <TableCell className="text-right"><PnlText value={b?.buy_hold_pct} /></TableCell>
                      <TableCell className="text-right font-mono text-loss">{toNum(b?.max_drawdown_pct).toFixed(1)} %</TableCell>
                      <TableCell className="text-right font-mono">{toNum(b?.sharpe_ratio).toFixed(2)}</TableCell>
                      <TableCell className="text-right font-mono">{b?.trades_count ?? 0}</TableCell>
                      <TableCell>
                        <Button variant="outline" size="sm" onClick={() => setSelectedId(b?.id ?? null)} className="gap-1">
                          <Eye className="h-3.5 w-3.5" /> Voir
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <EmptyBlock message="Aucun backtest enregistré. Lancez votre première simulation ci-dessus." />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
