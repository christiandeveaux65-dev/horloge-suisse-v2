import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiSession } from '@/lib/auth-guard'

export const dynamic = 'force-dynamic'

export async function GET() {
  const denied = await requireApiSession()
  if (denied) return denied
  try {
    const entries = await prisma.wallet_ledger.findMany({
      orderBy: { detected_at: 'desc' },
      take: 500,
    })
    let deposits = 0
    let withdrawals = 0
    for (const e of entries ?? []) {
      const v = parseFloat(e?.value_usd ?? '0')
      if (!Number.isFinite(v)) continue
      if (e?.kind === 'deposit') deposits += v
      else if (e?.kind === 'withdrawal') withdrawals += v
    }
    return NextResponse.json({
      entries: entries ?? [],
      totals: {
        deposits_usd: deposits,
        withdrawals_usd: withdrawals,
        net_usd: deposits - withdrawals,
      },
    })
  } catch {
    return NextResponse.json({ entries: [], totals: { deposits_usd: 0, withdrawals_usd: 0, net_usd: 0 } })
  }
}
