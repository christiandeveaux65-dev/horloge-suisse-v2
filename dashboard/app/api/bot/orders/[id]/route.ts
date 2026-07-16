import { NextResponse } from 'next/server'
import { botFetch } from '@/lib/bot-api'
import { requireApiSession } from '@/lib/auth-guard'

export const dynamic = 'force-dynamic'

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const denied = await requireApiSession()
  if (denied) return denied

  const rawId = params?.id ?? ''
  const id = encodeURIComponent(String(rawId).trim())
  if (!id) {
    return NextResponse.json({ error: 'ID ordre manquant' }, { status: 400 })
  }

  const r = await botFetch(`/api/orders/${id}`, { method: 'DELETE' })
  return NextResponse.json(r?.data ?? {}, { status: r?.status ?? 500 })
}
