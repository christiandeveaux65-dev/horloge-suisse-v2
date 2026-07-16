import { NextResponse } from 'next/server'
import { botFetch } from '@/lib/bot-api'
import { requireApiSession } from '@/lib/auth-guard'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const denied = await requireApiSession()
  if (denied) return denied
  const r = await botFetch('/api/risk/events')
  if (r?.ok) {
    return NextResponse.json(r?.data ?? [], { status: 200 })
  }
  // Fallback Prisma
  try {
    const events = await prisma.risk_event.findMany({
      orderBy: { created_at: 'desc' },
      take: 200,
    })
    return NextResponse.json(events ?? [])
  } catch {
    return NextResponse.json([])
  }
}
