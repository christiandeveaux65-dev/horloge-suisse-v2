import { NextResponse } from 'next/server'
import { botFetch } from '@/lib/bot-api'
import { requireApiSession } from '@/lib/auth-guard'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const denied = await requireApiSession()
  if (denied) return denied
  const r = await botFetch('/api/coupling/decisions')
  if (r?.ok) {
    return NextResponse.json(r?.data ?? [], { status: 200 })
  }
  try {
    const decisions = await prisma.coupling_decision.findMany({
      orderBy: { created_at: 'desc' },
      take: 300,
    })
    return NextResponse.json(decisions ?? [])
  } catch {
    return NextResponse.json([])
  }
}
