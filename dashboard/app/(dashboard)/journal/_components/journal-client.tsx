'use client'

import { useState, useMemo } from 'react'
import useSWR from 'swr'
import { fetcher } from '@/lib/fetcher'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { LoadingBlock, EmptyBlock, PageTitle, ChainBadge } from '@/components/dashboard/widgets'
import { fmtDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { BookOpenText, Zap, Brain } from 'lucide-react'
import type { CouplingDecision } from '@/lib/types'

const KIND_LABELS: Record<string, string> = {
  dca_modulation: 'Modulation DCA',
  strategist_iteration: 'Itération stratège',
  rebalance: 'Rééquilibrage',
}

export function JournalClient({ embedded = false }: { embedded?: boolean } = {}) {
  const { data: decisions, isLoading } = useSWR<CouplingDecision[]>('/api/bot/coupling/decisions', fetcher, { refreshInterval: 60000 })
  const [kind, setKind] = useState('all')

  const kinds = useMemo(() => Array.from(new Set((decisions ?? []).map((d) => d?.kind).filter(Boolean))), [decisions])
  const filtered = (decisions ?? []).filter((d) => kind === 'all' || d?.kind === kind)

  return (
    <div className="space-y-6">
      {!embedded && <PageTitle title="Journal du stratège" description="Décisions du moteur de couplage DCA × Momentum" icon={BookOpenText} />}

      <div className="flex flex-wrap gap-2">
        <Button variant={kind === 'all' ? 'default' : 'outline'} size="sm" onClick={() => setKind('all')}>
          Tout ({decisions?.length ?? 0})
        </Button>
        {kinds.map((k) => (
          <Button key={k} variant={kind === k ? 'default' : 'outline'} size="sm" onClick={() => setKind(k ?? 'all')}>
            {KIND_LABELS[k ?? ''] ?? k} ({(decisions ?? []).filter((d) => d?.kind === k).length})
          </Button>
        ))}
      </div>

      {isLoading ? (
        <LoadingBlock rows={6} />
      ) : (filtered ?? []).length > 0 ? (
        <div className="relative space-y-3 before:absolute before:left-[18px] before:top-2 before:bottom-2 before:w-px before:bg-border">
          {filtered.map((d) => (
            <div key={d?.id} className="relative pl-11">
              <div
                className={cn(
                  'absolute left-2 top-3 flex h-8 w-8 items-center justify-center rounded-full border bg-card',
                  d?.kind === 'dca_modulation' ? 'border-primary/40 text-primary' : 'border-sky-500/40 text-sky-400'
                )}
              >
                {d?.kind === 'dca_modulation' ? <Zap className="h-3.5 w-3.5" /> : <Brain className="h-3.5 w-3.5" />}
              </div>
              <Card className="glow-card border-border/60">
                <CardContent className="p-4">
                  <div className="flex flex-wrap items-center gap-2 mb-1.5">
                    <Badge variant="outline" className="border-primary/40 text-primary">
                      {KIND_LABELS[d?.kind ?? ''] ?? d?.kind}
                    </Badge>
                    {d?.chain ? <ChainBadge chain={d?.chain} /> : null}
                    {d?.token ? <Badge variant="outline" className="font-mono">{d?.token}</Badge> : null}
                    <span className="ml-auto font-mono text-xs text-muted-foreground">{fmtDate(d?.created_at)}</span>
                  </div>
                  <p className="text-sm">{d?.detail}</p>
                </CardContent>
              </Card>
            </div>
          ))}
        </div>
      ) : (
        <EmptyBlock message="Aucune décision enregistrée pour ce filtre." />
      )}
    </div>
  )
}
