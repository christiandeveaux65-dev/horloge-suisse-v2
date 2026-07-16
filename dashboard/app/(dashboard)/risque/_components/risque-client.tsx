'use client'

import { useState, useMemo } from 'react'
import useSWR from 'swr'
import { fetcher } from '@/lib/fetcher'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { StatCard, LoadingBlock, EmptyBlock, PageTitle } from '@/components/dashboard/widgets'
import { fmtUsd, fmtDate, toNum } from '@/lib/format'
import { ShieldAlert, ShieldCheck, Gauge, TrendingDown, PlayCircle, Loader2, AlertOctagon } from 'lucide-react'
import { toast } from 'sonner'
import type { RiskData } from '@/lib/types'

export function RisqueClient() {
  const { data: risk, isLoading, mutate } = useSWR<RiskData>('/api/bot/risk', fetcher, { refreshInterval: 60000 })
  const { data: events } = useSWR<any[]>('/api/bot/risk/events', fetcher, { refreshInterval: 60000 })
  const [kindFilter, setKindFilter] = useState('all')
  const [resuming, setResuming] = useState(false)

  const cfg = risk?.config
  const dd = Math.abs(toNum(risk?.portfolio?.drawdown_pct))
  const maxDd = cfg?.max_drawdown_pct ?? 15
  const ddRatio = maxDd > 0 ? Math.min(100, (dd / maxDd) * 100) : 0

  const kinds = useMemo(() => Array.from(new Set((events ?? []).map((e) => e?.kind).filter(Boolean))), [events])
  const filteredEvents = useMemo(
    () => (events ?? []).filter((e) => kindFilter === 'all' || e?.kind === kindFilter),
    [events, kindFilter]
  )

  const resume = async () => {
    setResuming(true)
    try {
      const res = await fetch('/api/bot/risk/resume', { method: 'POST' })
      if (res.ok) {
        toast.success('Trading repris avec succès')
        mutate()
      } else {
        toast.error('Impossible de reprendre le trading')
      }
    } catch {
      toast.error('Erreur réseau')
    }
    setResuming(false)
  }

  return (
    <div className="space-y-6">
      <PageTitle title="Gestion du risque" description="Garde-fous et événements de protection du capital" icon={ShieldAlert} />

      {cfg?.global_paused ? (
        <div className="rounded-xl border border-red-500/50 bg-red-500/10 p-5 glow-red">
          <div className="flex flex-wrap items-center gap-4">
            <AlertOctagon className="h-8 w-8 text-red-400 shrink-0" />
            <div className="flex-1 min-w-[200px]">
              <p className="font-display text-lg font-bold text-red-400">TRADING EN PAUSE</p>
              <p className="text-sm text-red-300/90">{cfg?.paused_reason || 'Raison non précisée'}</p>
              {cfg?.paused_at ? <p className="text-xs text-red-300/60 mt-1">Depuis le {fmtDate(cfg?.paused_at)}</p> : null}
            </div>
            <Button onClick={resume} disabled={resuming} aria-busy={resuming} className="gap-1.5 bg-red-500 hover:bg-red-600 text-white">
              {resuming ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <PlayCircle className="h-4 w-4" aria-hidden="true" />}
              Reprendre le trading
            </Button>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 flex items-center gap-3">
          <ShieldCheck className="h-5 w-5 text-primary" />
          <p className="text-sm">Trading actif — aucun garde-fou déclenché.</p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Drawdown max autorisé" value={`${maxDd} %`} icon={TrendingDown} delay={0} />
        <StatCard title="Limite par position" value={`${cfg?.position_limit_pct ?? '—'} %`} sub="du portefeuille" icon={Gauge} delay={0.05} />
        <StatCard
          title="Trailing stop"
          value={cfg?.trailing_enabled ? 'Activé' : 'Désactivé'}
          sub={cfg?.trailing_enabled ? `Déclenchement à +${cfg?.trailing_activation_pct ?? 0} %` : undefined}
          icon={ShieldCheck}
          delay={0.1}
        />
        <StatCard
          title="ATH du portefeuille"
          value={fmtUsd(cfg?.ath_value_usd)}
          sub={cfg?.ath_recorded_at ? `Atteint le ${fmtDate(cfg?.ath_recorded_at)}` : undefined}
          icon={Gauge}
          delay={0.15}
        />
      </div>

      <Card className="glow-card border-border/60">
        <CardHeader className="pb-2"><CardTitle className="text-base">Drawdown actuel vs maximum autorisé</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {isLoading ? (
            <LoadingBlock rows={2} />
          ) : (
            <>
              <div className="flex items-end justify-between">
                <div>
                  <p className="font-display text-3xl font-bold">
                    <span className={ddRatio > 66 ? 'text-loss' : ddRatio > 33 ? 'text-yellow-400' : 'text-gain'}>{dd.toFixed(2)} %</span>
                  </p>
                  <p className="text-xs text-muted-foreground">Valeur actuelle : {fmtUsd(risk?.portfolio?.total_usd)} · ATH : {fmtUsd(risk?.portfolio?.ath_usd)}</p>
                </div>
                <p className="text-sm text-muted-foreground">Seuil de pause : {maxDd} %</p>
              </div>
              <div className="h-3 w-full rounded-full bg-secondary overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{
                    width: `${Math.max(2, ddRatio)}%`,
                    background: ddRatio > 66 ? '#f87171' : ddRatio > 33 ? '#facc15' : '#2dd4a7',
                  }}
                />
              </div>
              <p className="text-xs text-muted-foreground">{ddRatio.toFixed(0)} % du drawdown maximum utilisé</p>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="glow-card border-border/60">
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-base">Événements de risque</CardTitle>
          <Select value={kindFilter} onValueChange={setKindFilter}>
            <SelectTrigger className="w-44" aria-label="Filtrer les événements de risque par type"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tous les types</SelectItem>
              {kinds.map((k) => <SelectItem key={k} value={k ?? ''}>{k}</SelectItem>)}
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent>
          {(filteredEvents ?? []).length > 0 ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Détail</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredEvents.map((e) => (
                    <TableRow key={e?.id}>
                      <TableCell><Badge variant="outline" className="border-yellow-500/40 text-yellow-400">{e?.kind}</Badge></TableCell>
                      <TableCell className="text-sm">{e?.detail || '—'}</TableCell>
                      <TableCell className="font-mono text-xs whitespace-nowrap">{fmtDate(e?.created_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <EmptyBlock message="Aucun événement de risque enregistré — c'est bon signe." />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
