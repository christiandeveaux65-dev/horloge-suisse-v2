'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { fetcher } from '@/lib/fetcher'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { StatusBadge, SideBadge, ChainBadge, LoadingBlock, EmptyBlock, PageTitle } from '@/components/dashboard/widgets'
import { fmtUsd, fmtNum, fmtDate } from '@/lib/format'
import { ListOrdered, Plus, XCircle, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type { Order } from '@/lib/types'

const CHAINS = ['arbitrum', 'base', 'optimism']

export function OrdresClient({ embedded = false }: { embedded?: boolean } = {}) {
  const { data: orders, isLoading, mutate } = useSWR<Order[]>('/api/bot/orders', fetcher, { refreshInterval: 30000 })
  const [statusFilter, setStatusFilter] = useState('all')
  const [showForm, setShowForm] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [cancelling, setCancelling] = useState<string | null>(null)

  const [form, setForm] = useState({
    kind: 'twap',
    chain: 'arbitrum',
    target_token: 'WETH',
    side: 'buy',
    total_amount: '100',
    tranches: '4',
    interval_seconds: '3600',
    target_price: '',
    slippage_bps: '100',
  })

  const filtered = (orders ?? []).filter((o) => statusFilter === 'all' || o?.status === statusFilter)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    try {
      const payload: any =
        form?.kind === 'limit'
          ? {
              kind: 'limit',
              chain: form?.chain,
              target_token: form?.target_token,
              side: form?.side,
              amount: form?.total_amount,
              target_price: form?.target_price,
              slippage_bps: parseInt(form?.slippage_bps ?? '100', 10),
            }
          : {
              kind: 'twap',
              chain: form?.chain,
              target_token: form?.target_token,
              total_amount: form?.total_amount,
              tranches: parseInt(form?.tranches ?? '1', 10),
              interval_seconds: parseInt(form?.interval_seconds ?? '3600', 10),
              slippage_bps: parseInt(form?.slippage_bps ?? '100', 10),
            }
      const res = await fetch('/api/bot/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const msg = Array.isArray(data?.message) ? data.message.join(' · ') : data?.message ?? data?.error ?? 'Erreur lors de la création'
        toast.error(msg)
      } else {
        toast.success('Ordre créé avec succès')
        setShowForm(false)
        mutate()
      }
    } catch {
      toast.error('Erreur réseau')
    }
    setSubmitting(false)
  }

  const cancel = async (id: string) => {
    setCancelling(id)
    try {
      const res = await fetch(`/api/bot/orders/${id}`, { method: 'DELETE' })
      if (res.ok) {
        toast.success('Ordre annulé')
        mutate()
      } else {
        const data = await res.json().catch(() => ({}))
        toast.error(data?.message ?? "Impossible d'annuler cet ordre")
      }
    } catch {
      toast.error('Erreur réseau')
    }
    setCancelling(null)
  }

  const set = (k: string, v: string) => setForm({ ...(form ?? {}), [k]: v })

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {!embedded && <PageTitle title="Ordres avancés" description="Ordres TWAP et Limit exécutés par le bot" icon={ListOrdered} />}
        <Button onClick={() => setShowForm(!showForm)} className="gap-1.5">
          <Plus className="h-4 w-4" /> Nouvel ordre
        </Button>
      </div>

      {showForm ? (
        <Card className="glow-card border-primary/30">
          <CardHeader className="pb-2"><CardTitle className="text-base">Créer un ordre</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-1.5">
                <Label>Type d'ordre</Label>
                <Select value={form?.kind} onValueChange={(v) => set('kind', v)}>
                  <SelectTrigger aria-label="Type d'ordre"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="twap">TWAP (achat fractionné)</SelectItem>
                    <SelectItem value="limit">Limit (prix cible)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Chain</Label>
                <Select value={form?.chain} onValueChange={(v) => set('chain', v)}>
                  <SelectTrigger aria-label="Réseau de l'ordre"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CHAINS.map((c) => <SelectItem key={c} value={c} className="capitalize">{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Token cible</Label>
                <Input value={form?.target_token ?? ''} onChange={(e) => set('target_token', e?.target?.value ?? '')} placeholder="WETH" required />
              </div>
              <div className="space-y-1.5">
                <Label>Montant total (USDC)</Label>
                <Input type="number" step="any" min="0" value={form?.total_amount ?? ''} onChange={(e) => set('total_amount', e?.target?.value ?? '')} required />
              </div>
              {form?.kind === 'twap' ? (
                <>
                  <div className="space-y-1.5">
                    <Label>Nombre de tranches</Label>
                    <Input type="number" min="1" value={form?.tranches ?? ''} onChange={(e) => set('tranches', e?.target?.value ?? '')} required />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Intervalle (secondes)</Label>
                    <Input type="number" min="60" value={form?.interval_seconds ?? ''} onChange={(e) => set('interval_seconds', e?.target?.value ?? '')} required />
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <Label>Sens</Label>
                    <Select value={form?.side} onValueChange={(v) => set('side', v)}>
                      <SelectTrigger aria-label="Sens de l'ordre limite"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="buy">Achat (si prix ≤ cible)</SelectItem>
                        <SelectItem value="sell">Vente (si prix ≥ cible)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Prix cible (USD)</Label>
                    <Input type="number" step="any" min="0" value={form?.target_price ?? ''} onChange={(e) => set('target_price', e?.target?.value ?? '')} required />
                  </div>
                </>
              )}
              <div className="space-y-1.5">
                <Label>Slippage (bps)</Label>
                <Input type="number" min="1" value={form?.slippage_bps ?? ''} onChange={(e) => set('slippage_bps', e?.target?.value ?? '')} />
              </div>
              <div className="flex items-end gap-2">
                <Button type="submit" disabled={submitting} className="gap-1.5">
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  Créer l'ordre
                </Button>
                <Button type="button" variant="outline" onClick={() => setShowForm(false)}>Annuler</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-44" aria-label="Filtrer les ordres par statut"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tous les statuts</SelectItem>
            <SelectItem value="pending">En attente</SelectItem>
            <SelectItem value="active">Actif</SelectItem>
            <SelectItem value="completed">Complété</SelectItem>
            <SelectItem value="cancelled">Annulé</SelectItem>
            <SelectItem value="failed">Échoué</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card className="glow-card border-border/60">
        <CardContent className="pt-6">
          {isLoading ? (
            <LoadingBlock rows={6} />
          ) : (filtered ?? []).length > 0 ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Chain</TableHead>
                    <TableHead>Paire</TableHead>
                    <TableHead>Sens</TableHead>
                    <TableHead className="text-right">Montant</TableHead>
                    <TableHead>Progression / Cible</TableHead>
                    <TableHead>Statut</TableHead>
                    <TableHead>Créé le</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((o) => {
                    const isTwap = o?.kind === 'twap'
                    const prog = isTwap && (o?.tranches_total ?? 0) > 0 ? ((o?.tranches_done ?? 0) / (o?.tranches_total ?? 1)) * 100 : 0
                    const cancellable = o?.status === 'pending' || o?.status === 'active'
                    return (
                      <TableRow key={o?.id}>
                        <TableCell>
                          <Badge variant="outline" className={isTwap ? 'border-sky-500/40 text-sky-400' : 'border-purple-500/40 text-purple-400'}>
                            {isTwap ? 'TWAP' : 'Limit'}
                          </Badge>
                        </TableCell>
                        <TableCell><ChainBadge chain={o?.chain} /></TableCell>
                        <TableCell className="font-semibold whitespace-nowrap">{o?.source_token} → {o?.target_token}</TableCell>
                        <TableCell><SideBadge side={o?.side} /></TableCell>
                        <TableCell className="text-right font-mono">{fmtNum(o?.total_amount_in)} {o?.source_token}</TableCell>
                        <TableCell className="min-w-[160px]">
                          {isTwap ? (
                            <div className="space-y-1">
                              <div className="flex justify-between text-xs">
                                <span className="text-muted-foreground">Tranches</span>
                                <span className="font-mono">{o?.tranches_done ?? 0}/{o?.tranches_total ?? 0}</span>
                              </div>
                              <Progress value={prog} className="h-1.5" />
                            </div>
                          ) : (
                            <span className="font-mono text-xs">
                              {o?.direction === 'above' ? '≥' : '≤'} {fmtUsd(o?.target_price)}
                            </span>
                          )}
                        </TableCell>
                        <TableCell><StatusBadge status={o?.status} /></TableCell>
                        <TableCell className="font-mono text-xs whitespace-nowrap">{fmtDate(o?.created_at)}</TableCell>
                        <TableCell>
                          {cancellable ? (
                            <Button variant="outline" size="sm" onClick={() => cancel(o?.id ?? '')} disabled={cancelling === o?.id} className="gap-1 text-red-400 border-red-500/40 hover:bg-red-500/10">
                              {cancelling === o?.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
                              Annuler
                            </Button>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          ) : (
            <EmptyBlock message="Aucun ordre pour ce filtre." />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
