'use client'

import { useMemo, useState } from 'react'
import useSWR from 'swr'
import Link from 'next/link'
import { fetcher } from '@/lib/fetcher'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import {
  StatCard,
  StatusBadge,
  SideBadge,
  ChainBadge,
  PnlText,
  TrendPill,
  TokenBadge,
  LoadingBlock,
  EmptyBlock,
  PageTitle,
} from '@/components/dashboard/widgets'
import { AreaSeries, Donut } from '@/components/charts'
import { fmtUsd, fmtNum, fmtDate, toNum, pctChange, periodLabel, CHAIN_LABELS, CHAIN_COLORS, tokenColor } from '@/lib/format'
import { Wallet, TrendingUp, Layers, LayoutDashboard, PiggyBank, ArrowRight, ShieldAlert, ShieldCheck, Radar } from 'lucide-react'
import { ScannerClient } from '@/app/(dashboard)/scanner/_components/scanner-client'
import type { Portfolio, Position, Trade } from '@/lib/types'

const PERIODS = [
  { hours: 24, label: '24 h' },
  { hours: 168, label: '7 j' },
  { hours: 720, label: '30 j' },
]

const KNOWN_CHAINS = ['arbitrum', 'base', 'optimism']

export function DashboardClient() {
  const { data: portfolio, isLoading: loadingPf } = useSWR<Portfolio>('/api/bot/portfolio', fetcher, { refreshInterval: 60000 })
  const { data: status } = useSWR('/api/bot/status', fetcher, { refreshInterval: 60000 })
  const { data: positions } = useSWR<Position[]>('/api/bot/positions', fetcher, { refreshInterval: 60000 })
  const { data: risk } = useSWR('/api/bot/risk', fetcher, { refreshInterval: 60000 })
  const [hours, setHours] = useState(720)
  const { data: history } = useSWR<{ t: number; total: number }[]>(`/api/portfolio-history?hours=${hours}`, fetcher, { refreshInterval: 120000 })
  const { data: tradesData } = useSWR('/api/bot/trades?limit=8', fetcher, { refreshInterval: 60000 })

  const totalValue = toNum(portfolio?.total_value_usd)
  // Source de vérité : pnl_summary fourni par l'API du bot (aucun recalcul côté frontend)
  const pnlNet = toNum(portfolio?.pnl_summary?.total_pnl_usd)
  const pnlPct = toNum(portfolio?.pnl_summary?.total_pnl_percent)
  const netDeposits = totalValue - pnlNet

  const openPositions = (positions ?? []).filter((p) => p?.status === 'open')
  const trades: Trade[] = tradesData?.trades ?? []
  const tradeStats = status?.trade_stats ?? {}

  // Historique réel : période effectivement couverte + variation + sparkline
  const hist = history ?? []
  const histStats = useMemo(() => {
    if (hist.length < 2) return null
    const first = hist[0]
    const last = hist[hist.length - 1]
    const spanHours = Math.max(1, Math.round((toNum(last?.t) - toNum(first?.t)) / 3_600_000))
    return {
      spanHours,
      changePct: pctChange(first?.total, last?.total),
      changeUsd: toNum(last?.total) - toNum(first?.total),
      spark: hist.map((p) => ({ v: toNum(p?.total) })),
    }
  }, [hist])

  // Chains : toujours afficher les 3, honnêtement (0 si aucune balance)
  const chains = KNOWN_CHAINS.map((name) => {
    const found = (portfolio?.chains ?? []).find((c) => c?.chain === name)
    const tokens = (found?.tokens ?? []).filter((t) => toNum(t?.balance) > 0)
    const total = tokens.reduce((acc, t) => acc + toNum(t?.value_usd), 0)
    return { name, label: CHAIN_LABELS[name] ?? name, color: CHAIN_COLORS[name] ?? '#a78bfa', tokens, total }
  })
  // Répartition par actif : agrégation des balances réelles (toutes chains), avec PnL par token si dispo
  const assets = useMemo(() => {
    const map = new Map<string, { symbol: string; value: number; balance: number }>()
    for (const c of portfolio?.chains ?? []) {
      for (const t of c?.tokens ?? []) {
        const bal = toNum(t?.balance)
        const val = toNum(t?.value_usd)
        if (bal <= 0 || val <= 0) continue
        const sym = t?.symbol ?? '?'
        const prev = map.get(sym) ?? { symbol: sym, value: 0, balance: 0 }
        prev.value += val
        prev.balance += bal
        map.set(sym, prev)
      }
    }
    const pnlOf = (sym: string) => (portfolio?.pnl ?? []).find((p) => p?.token === sym)
    return Array.from(map.values())
      .sort((a, b) => b.value - a.value)
      .map((a) => ({ ...a, pnl: pnlOf(a.symbol) }))
  }, [portfolio])
  const assetDonut = assets.map((a) => ({ name: a.symbol, value: a.value, color: tokenColor(a.symbol) }))

  // Risque
  const dd = Math.abs(toNum(risk?.portfolio?.drawdown_pct))
  const maxDd = toNum(risk?.config?.max_drawdown_pct) || 15
  const ddRatio = maxDd > 0 ? Math.min(100, (dd / maxDd) * 100) : 0
  const riskAlert = ddRatio >= 60

  return (
    <div className="space-y-6">
      <PageTitle title="Tableau de bord" description="Vue d'ensemble du portefeuille et de l'activité du bot" icon={LayoutDashboard} />

      {/* Bandeau risque */}
      {risk && (
        <div
          className={`flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-sm ${
            riskAlert ? 'border-red-500/40 bg-red-500/10 text-red-300' : 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300'
          }`}
        >
          {riskAlert ? <ShieldAlert className="h-4 w-4 shrink-0" /> : <ShieldCheck className="h-4 w-4 shrink-0" />}
          <span className="flex-1 min-w-[200px]">
            {riskAlert
              ? `Attention : drawdown de ${dd.toFixed(2)} % (${ddRatio.toFixed(0)} % de la limite de ${maxDd} %).`
              : `Risque sous contrôle : drawdown ${dd.toFixed(2)} % / limite ${maxDd} %.`}
          </span>
          <div className="h-1.5 w-32 rounded-full bg-muted overflow-hidden">
            <div
              className={`h-full rounded-full ${riskAlert ? 'bg-red-400' : 'bg-emerald-400'}`}
              style={{ width: `${Math.max(2, ddRatio)}%` }}
            />
          </div>
          <Button asChild variant="ghost" size="sm" className="gap-1 h-7 px-2 text-inherit hover:text-inherit">
            <Link href="/risque">Détails <ArrowRight className="h-3.5 w-3.5" /></Link>
          </Button>
        </div>
      )}

      {/* KPI */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Valeur du portefeuille"
          value={loadingPf ? '…' : fmtUsd(totalValue)}
          sub={
            <span className="flex items-center gap-2">
              {portfolio?.pnl_summary && <TrendPill value={pnlPct} />}
              <span className="text-xs text-muted-foreground">live via l'API du bot</span>
            </span>
          }
          icon={Wallet}
          delay={0}
        />
        <StatCard
          title="PnL net"
          value={<span className={pnlNet >= 0 ? 'text-gain' : 'text-loss'}>{loadingPf ? '…' : fmtUsd(pnlNet)}</span>}
          sub={<PnlText value={pnlPct} />}
          icon={TrendingUp}
          delay={0.05}
        />
        <StatCard
          title="Dépôts nets"
          value={loadingPf ? '…' : fmtUsd(netDeposits)}
          sub="valeur actuelle − PnL net"
          icon={PiggyBank}
          delay={0.1}
        />
        <StatCard
          title="Positions ouvertes"
          value={`${openPositions?.length ?? 0}`}
          sub={`Trades : ${tradeStats?.completed ?? 0} complétés · ${tradeStats?.failed ?? 0} échoués`}
          icon={Layers}
          delay={0.15}
        />
      </div>

      {/* Charts */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="glow-card border-border/60 lg:col-span-2">
          <CardHeader className="pb-2 flex flex-row flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">Évolution du portefeuille</CardTitle>
              {histStats && (
                <p className="text-xs text-muted-foreground mt-1">
                  {histStats.spanHours < hours * 0.9
                    ? `Historique disponible : ${periodLabel(histStats.spanHours)} (suivi démarré le ${fmtDate(hist[0]?.t)})`
                    : `Données réelles sur ${periodLabel(histStats.spanHours)}`}{' '}·{' '}
                  <span className={histStats.changeUsd >= 0 ? 'text-gain' : 'text-loss'}>
                    {histStats.changeUsd >= 0 ? '+' : ''}{fmtUsd(histStats.changeUsd)}
                  </span>
                </p>
              )}
            </div>
            <div className="flex gap-1">
              {PERIODS.map((p) => (
                <Button
                  key={p.hours}
                  variant={hours === p.hours ? 'default' : 'outline'}
                  size="sm"
                  className="h-7 px-2.5 text-xs"
                  onClick={() => setHours(p.hours)}
                >
                  {p.label}
                </Button>
              ))}
            </div>
          </CardHeader>
          <CardContent>
            {hist.length > 1 ? (
              <AreaSeries data={hist} height={280} />
            ) : (
              <EmptyBlock message="Pas encore assez d'historique de portefeuille sur cette période." />
            )}
          </CardContent>
        </Card>
        <Card className="glow-card border-border/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Répartition par actif</CardTitle>
            <p className="text-xs text-muted-foreground">Balances réelles du wallet, valorisées en direct</p>
          </CardHeader>
          <CardContent>
            {assetDonut.length > 0 ? (
              <>
                <Donut data={assetDonut} height={185} />
                <div className="mt-3 space-y-2">
                  {assets.map((a) => {
                    const pnlUsd = a.pnl ? toNum(a.pnl.pnl_usd) : null
                    const pnlPct = a.pnl ? toNum(a.pnl.pnl_percent) : null
                    return (
                      <div key={a.symbol} className="flex items-center gap-2 text-xs">
                        <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: tokenColor(a.symbol) }} />
                        <span className="font-semibold">{a.symbol}</span>
                        {pnlUsd !== null && pnlPct !== null && (
                          <span className={`font-mono ${pnlUsd >= 0 ? 'text-gain' : 'text-loss'}`}>
                            {pnlUsd >= 0 ? '+' : ''}{fmtUsd(pnlUsd)}
                          </span>
                        )}
                        <span className="ml-auto font-mono">
                          {fmtUsd(a.value)} · {totalValue > 0 ? ((a.value / totalValue) * 100).toFixed(1) : '0'} %
                        </span>
                      </div>
                    )
                  })}
                </div>
              </>
            ) : (
              <EmptyBlock message="Aucune balance détectée." />
            )}
          </CardContent>
        </Card>
      </div>

      {/* Multi-chain visuel */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">Balances multi-chain</h2>
          <Button asChild variant="outline" size="sm" className="gap-1.5">
            <Link href="/risque#multichain">Vue détaillée <ArrowRight className="h-3.5 w-3.5" /></Link>
          </Button>
        </div>
        {loadingPf ? (
          <LoadingBlock />
        ) : (
          <div className="grid gap-4 lg:grid-cols-3">
            {chains.map((c) => (
              <Card key={c.name} className="glow-card border-border/60 overflow-hidden">
                <div className="h-1 w-full" style={{ backgroundColor: c.color, opacity: c.total > 0 ? 1 : 0.25 }} />
                <CardHeader className="pb-2 flex flex-row items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="h-3 w-3 rounded-full" style={{ backgroundColor: c.color }} />
                    <CardTitle className="text-base">{c.label}</CardTitle>
                  </div>
                  <div className="text-right">
                    <p className="font-mono font-semibold">{fmtUsd(c.total)}</p>
                    <p className="text-xs text-muted-foreground">
                      {totalValue > 0 ? ((c.total / totalValue) * 100).toFixed(1) : '0'} % du portefeuille
                    </p>
                  </div>
                </CardHeader>
                <CardContent>
                  {c.tokens.length > 0 ? (
                    <div className="space-y-3">
                      {c.tokens
                        .slice()
                        .sort((a, b) => toNum(b?.value_usd) - toNum(a?.value_usd))
                        .map((t) => {
                          const share = c.total > 0 ? (toNum(t?.value_usd) / c.total) * 100 : 0
                          return (
                            <div key={t?.symbol} className="flex items-center gap-3">
                              <TokenBadge symbol={t?.symbol ?? '?'} size={30} />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-baseline justify-between gap-2">
                                  <span className="font-semibold text-sm">{t?.symbol}</span>
                                  <span className="font-mono text-sm">{fmtUsd(t?.value_usd)}</span>
                                </div>
                                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                                  <span className="font-mono truncate">{fmtNum(t?.balance)} · {fmtUsd(t?.price_usd)}</span>
                                  <span>{share.toFixed(1)} %</span>
                                </div>
                                <div className="mt-1 h-1 rounded-full bg-muted overflow-hidden">
                                  <div className="h-full rounded-full" style={{ width: `${Math.max(2, share)}%`, backgroundColor: tokenColor(t?.symbol) }} />
                                </div>
                              </div>
                            </div>
                          )
                        })}
                    </div>
                  ) : (
                    <p className="py-6 text-center text-sm text-muted-foreground">Aucun fonds sur cette chain pour le moment.</p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Scanner d'opportunités */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Radar className="h-4 w-4 text-primary" />
            Scanner d'opportunités
          </h2>
          <Button asChild variant="outline" size="sm" className="gap-1.5">
            <Link href="/strategies?tab=scanner">Vue complète <ArrowRight className="h-3.5 w-3.5" /></Link>
          </Button>
        </div>
        <ScannerClient embedded />
      </div>

      {/* Positions ouvertes + derniers trades */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="glow-card border-border/60">
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-base">Positions ouvertes</CardTitle>
            <Button asChild variant="outline" size="sm" className="gap-1.5">
              <Link href="/trading">Tout voir <ArrowRight className="h-3.5 w-3.5" /></Link>
            </Button>
          </CardHeader>
          <CardContent>
            {(openPositions ?? []).length > 0 ? (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Token</TableHead>
                      <TableHead>Chain</TableHead>
                      <TableHead className="text-right">Prix d'entrée</TableHead>
                      <TableHead className="text-right">Coût</TableHead>
                      <TableHead className="text-right">PnL latent</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {openPositions.slice(0, 6).map((p) => (
                      <TableRow key={p?.id}>
                        <TableCell>
                          <span className="flex items-center gap-2 font-semibold">
                            <TokenBadge symbol={p?.token ?? '?'} size={24} />
                            {p?.token}
                          </span>
                        </TableCell>
                        <TableCell><ChainBadge chain={p?.chain} /></TableCell>
                        <TableCell className="text-right font-mono">{fmtUsd(p?.entry_price)}</TableCell>
                        <TableCell className="text-right font-mono">{fmtUsd(p?.cost_usd)}</TableCell>
                        <TableCell className="text-right">
                          {p?.unrealized_pnl_usd != null ? (
                            <span className={`font-mono ${toNum(p?.unrealized_pnl_usd) >= 0 ? 'text-gain' : 'text-loss'}`}>
                              {toNum(p?.unrealized_pnl_usd) >= 0 ? '+' : ''}{fmtUsd(p?.unrealized_pnl_usd)}
                            </span>
                          ) : '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <EmptyBlock message="Aucune position ouverte actuellement." />
            )}
          </CardContent>
        </Card>

        <Card className="glow-card border-border/60">
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-base">Derniers trades</CardTitle>
            <Button asChild variant="outline" size="sm" className="gap-1.5">
              <Link href="/trading?tab=trades">Tout voir <ArrowRight className="h-3.5 w-3.5" /></Link>
            </Button>
          </CardHeader>
          <CardContent>
            {(trades ?? []).length > 0 ? (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Paire</TableHead>
                      <TableHead>Sens</TableHead>
                      <TableHead>Statut</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {trades.slice(0, 6).map((t) => (
                      <TableRow key={t?.id}>
                        <TableCell className="font-mono text-xs whitespace-nowrap">{fmtDate(t?.executed_at)}</TableCell>
                        <TableCell className="font-semibold whitespace-nowrap">{t?.source_token} → {t?.target_token}</TableCell>
                        <TableCell><SideBadge side={t?.side} /></TableCell>
                        <TableCell><StatusBadge status={t?.status} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <EmptyBlock message="Aucun trade enregistré. Le bot n'a pas encore exécuté d'ordre." />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
