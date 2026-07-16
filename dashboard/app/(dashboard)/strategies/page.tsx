import { Suspense } from 'react'
import { StrategiesClient } from './_components/strategies-client'
export const dynamic = 'force-dynamic'
export default function StrategiesPage() {
  return (
    <Suspense>
      <StrategiesClient />
    </Suspense>
  )
}
