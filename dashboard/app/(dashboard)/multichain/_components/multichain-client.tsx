'use client'

import useSWR from 'swr'
import { fetcher } from '@/lib/fetcher'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { StatCard, LoadingBlock, EmptyBlock, PageTitle, ChainBadge } from '@/components/dashboard/widgets'
import { Donut } from '@/components/charts'
import { fmtUsd, fmtNum, toNum, CHAIN_LABELS, CHAIN_COLORS } from '@/lib/format'
import { Network, Globe, Coins } from 'lucide-react'
import type { Portfolio } from '@/lib/types'

const KNOWN_CHAINS = ['arbitrum', 'base', 'optimism']

export function MultichainClient({ embedded = false }: { embedded?: boolean } = {}) {
  const { data: portfolio, isLoading } = useSWR<Portfolio>('/api/bot/portfolio', fetcher, { refreshInterval: 60000 })

  const chains = KNOWN_CHAINS.map((name) => {
    const found = (portfolio?.chains ?? []).find((c) => c?.chain === name)
    const tokens = (found?.tokens ?? []).filter((t) => toNum(t?.balance) > 0)
    const total = (found?.tokens ?? []).reduce((acc, t) => acc + toNum(t?.value_usd), 0)
    return { chain: name, tokens, total }
  })
  // Chains supplémentaires éventuelles
  for (const c of portfolio?.chains ?? []) {
    if (!KNOWN_CHAINS.includes(c?.chain ?? '')) {
      chains.push({
        chain: c?.chain ?? 'autre',
        tokens: (c?.tokens ?? []).filter((t) => toNum(t?.balance) > 0),
        total: (c?.tokens ?? []).reduce((acc, t) => acc + toNum(t?.value_usd), 0),
      })
    }
  }

  const totalAll = chains.reduce((acc, c) => acc + (c?.total ?? 0), 0)
  const donutData = chains.map((c) => ({
    name: CHAIN_LABELS[c?.chain ?? ''] ?? c?.chain ?? '—',
    value: c?.total ?? 0,
    color: CHAIN_COLORS[c?.chain ?? ''] ?? '#a78bfa',
  }))

  return (
    <div className="space-y-6">
      {!embedded && <PageTitle title="Multi-chain" description="Balances et répartition du portefeuille par blockchain" icon={Network} />}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Total cross-chain" value={isLoading ? '…' : fmtUsd(totalAll)} icon={Globe} delay={0} />
        {chains.slice(0, 3).map((c, i) => (
          <StatCard
            key={c?.chain}
            title={CHAIN_LABELS[c?.chain ?? ''] ?? c?.chain ?? '—'}
            value={isLoading ? '…' : fmtUsd(c?.total)}
            sub={`${c?.tokens?.length ?? 0} token(s)`}
            icon={Coins}
            delay={0.05 * (i + 1)}
          />
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="glow-card border-border/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Répartition par chain</CardTitle>
          </CardHeader>
          <CardContent>
            {totalAll > 0 ? <Donut data={donutData} height={280} /> : <EmptyBlock message="Aucune balance." />}
          </CardContent>
        </Card>

        <div className="lg:col-span-2 space-y-4">
          {isLoading ? (
            <LoadingBlock rows={6} />
          ) : (
            chains.map((c) => (
              <Card key={c?.chain} className="glow-card border-border/60">
                <CardHeader className="pb-2 flex flex-row items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ChainBadge chain={c?.chain} />
                    <CardTitle className="text-base">{CHAIN_LABELS[c?.chain ?? ''] ?? c?.chain}</CardTitle>
                  </div>
                  <span className="font-mono font-semibold">{fmtUsd(c?.total)}</span>
                </CardHeader>
                <CardContent>
                  {(c?.tokens ?? []).length > 0 ? (
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Token</TableHead>
                            <TableHead className="text-right">Balance</TableHead>
                            <TableHead className="text-right">Prix</TableHead>
                            <TableHead className="text-right">Valeur</TableHead>
                            <TableHead className="text-right">Part</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {(c?.tokens ?? []).map((t) => (
                            <TableRow key={t?.symbol}>
                              <TableCell className="font-semibold">{t?.symbol}</TableCell>
                              <TableCell className="text-right font-mono">{fmtNum(t?.balance)}</TableCell>
                              <TableCell className="text-right font-mono">{fmtUsd(t?.price_usd)}</TableCell>
                              <TableCell className="text-right font-mono font-semibold">{fmtUsd(t?.value_usd)}</TableCell>
                              <TableCell className="text-right font-mono text-muted-foreground">
                                {(c?.total ?? 0) > 0 ? `${((toNum(t?.value_usd) / (c?.total ?? 1)) * 100).toFixed(1)} %` : '—'}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  ) : (
                    <EmptyBlock message={`Aucun token détecté sur ${CHAIN_LABELS[c?.chain ?? ''] ?? c?.chain}.`} />
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
