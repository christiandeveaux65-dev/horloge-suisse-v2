'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PageTitle } from '@/components/dashboard/widgets'
import { CandlestickChart, Layers, ListOrdered, ArrowLeftRight } from 'lucide-react'
import { PositionsClient } from '../../positions/_components/positions-client'
import { OrdresClient } from '../../ordres/_components/ordres-client'
import { TradesClient } from '../../trades/_components/trades-client'

const VALID = ['positions', 'ordres', 'trades']

export function TradingClient() {
  const params = useSearchParams()
  const initial = params?.get('tab') ?? 'positions'
  const [tab, setTab] = useState(VALID.includes(initial) ? initial : 'positions')

  return (
    <div className="space-y-6">
      <PageTitle title="Trading" description="Positions, ordres avancés et historique des trades" icon={CandlestickChart} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap h-auto" aria-label="Sections de la page trading">
          <TabsTrigger value="positions" className="gap-1.5"><Layers className="h-3.5 w-3.5" /> Positions</TabsTrigger>
          <TabsTrigger value="ordres" className="gap-1.5"><ListOrdered className="h-3.5 w-3.5" /> Ordres avancés</TabsTrigger>
          <TabsTrigger value="trades" className="gap-1.5"><ArrowLeftRight className="h-3.5 w-3.5" /> Timeline trades</TabsTrigger>
        </TabsList>
        <TabsContent value="positions" className="mt-4"><PositionsClient embedded /></TabsContent>
        <TabsContent value="ordres" className="mt-4"><OrdresClient embedded /></TabsContent>
        <TabsContent value="trades" className="mt-4"><TradesClient embedded /></TabsContent>
      </Tabs>
    </div>
  )
}
