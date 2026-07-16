'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import useSWR from 'swr'
import { fetcher } from '@/lib/fetcher'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PageTitle, TokenBadge, ChainBadge, LoadingBlock, EmptyBlock } from '@/components/dashboard/widgets'
import { fmtUsd, fmtDate, toNum } from '@/lib/format'
import { BrainCircuit, Repeat, Zap, Link2, Radar, BookOpenText, LineChart } from 'lucide-react'
import { ScannerClient } from '../../scanner/_components/scanner-client'
import { JournalClient } from '../../journal/_components/journal-client'
import { PrixClient } from '../../prix/_components/prix-client'

const VALID = ['dca', 'momentum', 'couplage', 'scanner', 'journal', 'prix']

const FREQ_LABELS: Record<string, string> = {
  hourly: 'Toutes les heures',
  daily: 'Quotidien',
  weekly: 'Hebdomadaire',
}

function ActiveBadge({ active, paused }: { active?: boolean; paused?: boolean }) {
  if (paused) return <Badge variant="outline" className="border-amber-500/50 text-amber-400 bg-amber-500/10">En pause</Badge>
  if (active) return <Badge variant="outline" className="border-emerald-500/50 text-emerald-400 bg-emerald-500/10">Active</Badge>
  return <Badge variant="outline" className="border-muted-foreground/40 text-muted-foreground">Inactive</Badge>
}

function DcaView() {
  const { data: strategies, isLoading } = useSWR<any[]>('/api/bot/strategies', fetcher, { refreshInterval: 60000 })
  if (isLoading) return <LoadingBlock rows={3} />
  if (!(strategies ?? []).length) return <EmptyBlock message="Aucune stratégie DCA configurée." />
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {(strategies ?? []).map((s) => (
        <Card key={s?.id} className="glow-card border-border/60">
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <div className="flex items-center gap-2">
              <Repeat className="h-4 w-4 text-primary" />
              <CardTitle className="text-base">{s?.name ?? 'Stratégie DCA'}</CardTitle>
            </div>
            <ActiveBadge active={s?.active} paused={s?.paused} />
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              <TokenBadge symbol={s?.source_token ?? '?'} size={26} />
              <span className="text-sm font-semibold">{s?.source_token}</span>
              <span className="text-muted-foreground">→</span>
              <TokenBadge symbol={s?.target_token ?? '?'} size={26} />
              <span className="text-sm font-semibold">{s?.target_token}</span>
              <span className="ml-auto"><ChainBadge chain={s?.chain} /></span>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <div><p className="text-xs text-muted-foreground">Montant par achat</p><p className="font-mono font-semibold">{fmtUsd(s?.amount_per_buy)}</p></div>
              <div><p className="text-xs text-muted-foreground">Fréquence</p><p className="font-semibold">{FREQ_LABELS[s?.frequency ?? ''] ?? s?.frequency ?? '—'}</p></div>
              <div><p className="text-xs text-muted-foreground">Max par trade</p><p className="font-mono">{fmtUsd(s?.max_per_trade)}</p></div>
              <div><p className="text-xs text-muted-foreground">Slippage max</p><p className="font-mono">{toNum(s?.slippage_bps) / 100} %</p></div>
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{s?.smart_dca ? 'Smart DCA activé (modulation par le marché)' : 'DCA classique'}</span>
              <span>Maj : {fmtDate(s?.updated_at)}</span>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function MomentumView() {
  const { data: configs, isLoading } = useSWR<any[]>('/api/bot/momentum-config', fetcher, { refreshInterval: 60000 })
  if (isLoading) return <LoadingBlock rows={3} />
  if (!(configs ?? []).length) return <EmptyBlock message="Aucune configuration momentum." />
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {(configs ?? []).map((c) => {
        const budget = toNum(c?.budget_usd)
        const deployed = toNum(c?.deployed_usd)
        const ratio = budget > 0 ? Math.min(100, (deployed / budget) * 100) : 0
        const tokens = String(c?.tokens ?? '').split(',').map((t) => t.trim()).filter(Boolean)
        return (
          <Card key={c?.id} className="glow-card border-border/60">
            <CardHeader className="pb-2 flex flex-row items-center justify-between">
              <div className="flex items-center gap-2">
                <Zap className="h-4 w-4 text-accent" />
                <CardTitle className="text-base">{c?.name ?? 'Momentum'}</CardTitle>
              </div>
              <ActiveBadge active={c?.active} paused={c?.paused} />
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {tokens.map((t) => (
                  <span key={t} className="flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-xs">
                    <TokenBadge symbol={t} size={16} /> {t}
                  </span>
                ))}
                <span className="ml-auto"><ChainBadge chain={c?.chain} /></span>
              </div>
              <div>
                <div className="flex items-baseline justify-between text-sm">
                  <span className="text-xs text-muted-foreground">Budget déployé</span>
                  <span className="font-mono">{fmtUsd(deployed)} / {fmtUsd(budget)}</span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-muted overflow-hidden">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(2, ratio)}%` }} />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{ratio.toFixed(0)} % du budget engagé</p>
              </div>
              <div className="grid grid-cols-3 gap-x-4 gap-y-2 text-sm">
                <div><p className="text-xs text-muted-foreground">Stop-loss</p><p className="font-mono text-loss">-{toNum(c?.stop_loss_pct)} %</p></div>
                <div><p className="text-xs text-muted-foreground">Take-profit</p><p className="font-mono text-gain">+{String(c?.take_profit_levels ?? '—').split(',').join(' / +')} %</p></div>
                <div><p className="text-xs text-muted-foreground">Max/trade</p><p className="font-mono">{toNum(c?.max_per_trade_pct)} %</p></div>
                <div><p className="text-xs text-muted-foreground">MA courte/longue</p><p className="font-mono">{c?.ma_short} / {c?.ma_long}</p></div>
                <div><p className="text-xs text-muted-foreground">RSI période</p><p className="font-mono">{c?.rsi_period}</p></div>
                <div><p className="text-xs text-muted-foreground">RSI seuils</p><p className="font-mono">{c?.rsi_oversold} / {c?.rsi_overbought}</p></div>
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

function CouplageView() {
  const { data: cfg, isLoading } = useSWR<any>('/api/bot/coupling/config', fetcher, { refreshInterval: 60000 })
  if (isLoading) return <LoadingBlock rows={2} />
  if (!cfg) return <EmptyBlock message="Configuration de couplage indisponible." />
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="glow-card border-border/60">
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <div className="flex items-center gap-2"><Link2 className="h-4 w-4 text-primary" /><CardTitle className="text-base">Modulation DCA × Momentum</CardTitle></div>
            <ActiveBadge active={!!cfg?.modulation_enabled} />
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-muted-foreground text-xs">Le signal momentum module l'intensité des achats DCA.</p>
            <div className="grid grid-cols-2 gap-4">
              <div><p className="text-xs text-muted-foreground">Boost max (marché baissier)</p><p className="font-mono font-semibold text-gain">× {toNum(cfg?.boost_max).toFixed(2)}</p></div>
              <div><p className="text-xs text-muted-foreground">Frein min (marché haussier)</p><p className="font-mono font-semibold text-loss">× {toNum(cfg?.brake_min).toFixed(2)}</p></div>
            </div>
          </CardContent>
        </Card>
        <Card className="glow-card border-border/60">
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <div className="flex items-center gap-2"><Repeat className="h-4 w-4 text-accent" /><CardTitle className="text-base">Rééquilibrage automatique</CardTitle></div>
            <ActiveBadge active={!!cfg?.rebalance_enabled} />
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-muted-foreground text-xs">Rééquilibre les budgets entre stratégies selon la performance.</p>
            <div className="grid grid-cols-2 gap-4">
              <div><p className="text-xs text-muted-foreground">Seuil de déclenchement</p><p className="font-mono font-semibold">{toNum(cfg?.rebalance_threshold_pct)} %</p></div>
              <div><p className="text-xs text-muted-foreground">Transfert max</p><p className="font-mono font-semibold">{toNum(cfg?.rebalance_max_pct)} %</p></div>
            </div>
          </CardContent>
        </Card>
      </div>
      <p className="text-xs text-muted-foreground">Dernière mise à jour : {fmtDate(cfg?.updated_at)} · Les décisions du moteur sont visibles dans l'onglet « Journal ».</p>
    </div>
  )
}

export function StrategiesClient() {
  const params = useSearchParams()
  const initial = params?.get('tab') ?? 'dca'
  const [tab, setTab] = useState(VALID.includes(initial) ? initial : 'dca')

  return (
    <div className="space-y-6">
      <PageTitle title="Stratégies" description="Moteurs DCA, momentum, couplage et outils du stratège" icon={BrainCircuit} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap h-auto" aria-label="Sections de la page stratégies">
          <TabsTrigger value="dca" className="gap-1.5"><Repeat className="h-3.5 w-3.5" /> DCA</TabsTrigger>
          <TabsTrigger value="momentum" className="gap-1.5"><Zap className="h-3.5 w-3.5" /> Momentum</TabsTrigger>
          <TabsTrigger value="couplage" className="gap-1.5"><Link2 className="h-3.5 w-3.5" /> Couplage</TabsTrigger>
          <TabsTrigger value="scanner" className="gap-1.5"><Radar className="h-3.5 w-3.5" /> Scanner</TabsTrigger>
          <TabsTrigger value="journal" className="gap-1.5"><BookOpenText className="h-3.5 w-3.5" /> Journal</TabsTrigger>
          <TabsTrigger value="prix" className="gap-1.5"><LineChart className="h-3.5 w-3.5" /> Prix</TabsTrigger>
        </TabsList>
        <TabsContent value="dca" className="mt-4"><DcaView /></TabsContent>
        <TabsContent value="momentum" className="mt-4"><MomentumView /></TabsContent>
        <TabsContent value="couplage" className="mt-4"><CouplageView /></TabsContent>
        <TabsContent value="scanner" className="mt-4"><ScannerClient embedded /></TabsContent>
        <TabsContent value="journal" className="mt-4"><JournalClient embedded /></TabsContent>
        <TabsContent value="prix" className="mt-4"><PrixClient embedded /></TabsContent>
      </Tabs>
    </div>
  )
}
