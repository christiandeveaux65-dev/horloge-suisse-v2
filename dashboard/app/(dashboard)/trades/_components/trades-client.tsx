'use client'

import { useState, useMemo } from 'react'
import useSWR from 'swr'
import { fetcher } from '@/lib/fetcher'
import { Card, CardContent } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { StatusBadge, SideBadge, ChainBadge, LoadingBlock, EmptyBlock, PageTitle } from '@/components/dashboard/widgets'
import { fmtUsd, fmtNum, fmtDate } from '@/lib/format'
import { ArrowLeftRight } from 'lucide-react'
import type { Trade } from '@/lib/types'

export function TradesClient({ embedded = false }: { embedded?: boolean } = {}) {
  const { data, isLoading } = useSWR('/api/bot/trades?limit=500', fetcher, { refreshInterval: 60000 })
  const trades: Trade[] = data?.trades ?? []

  const [chain, setChain] = useState('all')
  const [token, setToken] = useState('all')
  const [side, setSide] = useState('all')
  const [status, setStatus] = useState('all')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const chains = useMemo(() => Array.from(new Set((trades ?? []).map((t) => t?.chain).filter(Boolean))), [trades])
  const tokens = useMemo(
    () => Array.from(new Set((trades ?? []).flatMap((t) => [t?.source_token, t?.target_token]).filter(Boolean))),
    [trades]
  )

  const filtered = useMemo(
    () =>
      (trades ?? []).filter((t) => {
        if (chain !== 'all' && t?.chain !== chain) return false
        if (token !== 'all' && t?.source_token !== token && t?.target_token !== token) return false
        if (side !== 'all' && t?.side !== side) return false
        if (status !== 'all' && t?.status !== status) return false
        const d = new Date(t?.executed_at ?? 0).getTime()
        if (from && d < new Date(from).getTime()) return false
        if (to && d > new Date(to).getTime() + 86400000) return false
        return true
      }),
    [trades, chain, token, side, status, from, to]
  )

  return (
    <div className="space-y-6">
      {!embedded && <PageTitle title="Timeline des trades" description={`${filtered?.length ?? 0} trade(s) affiché(s)`} icon={ArrowLeftRight} />}

      <div className="flex flex-wrap gap-3">
        <Select value={chain} onValueChange={setChain}>
          <SelectTrigger className="w-40" aria-label="Filtrer les trades par réseau"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Toutes les chains</SelectItem>
            {chains.map((c) => <SelectItem key={c} value={c ?? ''} className="capitalize">{c}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={token} onValueChange={setToken}>
          <SelectTrigger className="w-36" aria-label="Filtrer les trades par token"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tous les tokens</SelectItem>
            {tokens.map((t) => <SelectItem key={t} value={t ?? ''}>{t}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={side} onValueChange={setSide}>
          <SelectTrigger className="w-32" aria-label="Filtrer les trades par sens"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Achat & vente</SelectItem>
            <SelectItem value="buy">Achat</SelectItem>
            <SelectItem value="sell">Vente</SelectItem>
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-36" aria-label="Filtrer les trades par statut"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tous les statuts</SelectItem>
            <SelectItem value="completed">Complété</SelectItem>
            <SelectItem value="failed">Échoué</SelectItem>
            <SelectItem value="pending">En attente</SelectItem>
          </SelectContent>
        </Select>
        <Input type="date" value={from} onChange={(e) => setFrom(e?.target?.value ?? '')} className="w-40" aria-label="Date début" />
        <Input type="date" value={to} onChange={(e) => setTo(e?.target?.value ?? '')} className="w-40" aria-label="Date fin" />
      </div>

      <Card className="glow-card border-border/60">
        <CardContent className="pt-6">
          {isLoading ? (
            <LoadingBlock rows={8} />
          ) : (filtered ?? []).length > 0 ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Chain</TableHead>
                    <TableHead>Paire</TableHead>
                    <TableHead>Sens</TableHead>
                    <TableHead className="text-right">Montant in</TableHead>
                    <TableHead className="text-right">Montant out</TableHead>
                    <TableHead className="text-right">Prix</TableHead>
                    <TableHead>Statut</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((t) => (
                    <TableRow key={t?.id}>
                      <TableCell className="font-mono text-xs whitespace-nowrap">{fmtDate(t?.executed_at)}</TableCell>
                      <TableCell className="text-xs capitalize">{t?.source === 'dca' ? 'DCA' : t?.source === 'momentum' ? 'Momentum' : t?.source}</TableCell>
                      <TableCell><ChainBadge chain={t?.chain} /></TableCell>
                      <TableCell className="font-semibold whitespace-nowrap">{t?.source_token} → {t?.target_token}</TableCell>
                      <TableCell><SideBadge side={t?.side} /></TableCell>
                      <TableCell className="text-right font-mono">{fmtNum(t?.amount_in)}</TableCell>
                      <TableCell className="text-right font-mono">{fmtNum(t?.amount_out)}</TableCell>
                      <TableCell className="text-right font-mono">{fmtUsd(t?.price)}</TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <StatusBadge status={t?.status} />
                          {t?.error_message ? <span className="text-[10px] text-red-400/80 max-w-[220px] truncate" title={t?.error_message ?? ''}>{t?.error_message}</span> : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <EmptyBlock message="Aucun trade ne correspond aux filtres sélectionnés." />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
