import { Suspense } from 'react'
import { TradingClient } from './_components/trading-client'
export const dynamic = 'force-dynamic'
export default function TradingPage() {
  return (
    <Suspense>
      <TradingClient />
    </Suspense>
  )
}
