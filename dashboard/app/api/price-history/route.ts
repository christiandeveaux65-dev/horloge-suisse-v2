import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiSession } from '@/lib/auth-guard'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const denied = await requireApiSession()
  if (denied) return denied
  try {
    const url = new URL(req.url)
    const meta = url.searchParams.get('meta')

    if (meta === 'tokens') {
      const groups = await prisma.price_history.groupBy({
        by: ['chain', 'token'],
        _count: true,
      })
      return NextResponse.json(
        (groups ?? []).map((g: any) => ({ chain: g?.chain, token: g?.token, count: g?._count ?? 0 }))
      )
    }

    const chain = url.searchParams.get('chain') ?? undefined
    const token = url.searchParams.get('token') ?? undefined
    const hours = parseInt(url.searchParams.get('hours') ?? '168', 10)
    const since = new Date(Date.now() - (Number.isFinite(hours) ? hours : 168) * 3600 * 1000)

    const rows = await prisma.price_history.findMany({
      where: {
        ...(chain ? { chain } : {}),
        ...(token ? { token } : {}),
        recorded_at: { gte: since },
      },
      orderBy: { recorded_at: 'asc' },
      take: 5000,
    })

    return NextResponse.json(
      (rows ?? []).map((r: any) => ({
        chain: r?.chain,
        token: r?.token,
        price: parseFloat(r?.price_usd ?? '0'),
        t: new Date(r?.recorded_at ?? 0).getTime(),
      }))
    )
  } catch (e: any) {
    return NextResponse.json({ error: 'Erreur de lecture des prix' }, { status: 500 })
  }
}
