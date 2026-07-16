import { Suspense } from 'react'
import { AnalyticsHubClient } from './_components/analytics-hub-client'
export const dynamic = 'force-dynamic'
export default function AnalyticsPage() {
  return (
    <Suspense>
      <AnalyticsHubClient />
    </Suspense>
  )
}
