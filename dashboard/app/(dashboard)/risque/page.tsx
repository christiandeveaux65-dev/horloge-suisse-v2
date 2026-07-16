import { RisqueClient } from './_components/risque-client'
import { MultichainClient } from '../multichain/_components/multichain-client'
export const dynamic = 'force-dynamic'
export default function RisquePage() {
  return (
    <div className="space-y-10">
      <RisqueClient />
      <section id="multichain" className="space-y-4">
        <h2 className="font-display text-lg font-bold">Vue multi-chain</h2>
        <MultichainClient embedded />
      </section>
    </div>
  )
}
