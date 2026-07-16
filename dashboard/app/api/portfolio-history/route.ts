import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiSession } from '@/lib/auth-guard'

export const dynamic = 'force-dynamic'

/**
 * Historique de la VALEUR du portefeuille, à partir des snapshots réels
 * enregistrés par le bot (valorisation on-chain de chaque token).
 * - Respecte le paramètre ?hours= (24 / 168 / 720)
 * - Granularité adaptative : 5 min (24 h), 30 min (7 j), 2 h (30 j)
 */
export async function GET(req: Request) {
  const denied = await requireApiSession()
  if (denied) return denied
  try {
    const url = new URL(req.url)
    const hoursRaw = parseInt(url.searchParams.get('hours') ?? '720', 10)
    const hours = Number.isFinite(hoursRaw) && hoursRaw > 0 ? hoursRaw : 720
    const since = new Date(Date.now() - hours * 3600 * 1000)

    // Granularité adaptée à la période demandée
    const bucketMs = hours <= 24 ? 300000 : hours <= 168 ? 1800000 : 7200000

    const snaps = await prisma.portfolio_snapshot.findMany({
      where: { snapshot_at: { gte: since } },
      orderBy: { snapshot_at: 'asc' },
      take: 10000,
    })

    // 1) Regroupe par minute en dédupliquant par token/chain (le bot écrit parfois
    //    deux lots dans la même minute — on garde la dernière valeur de chaque token
    //    pour ne jamais compter deux fois la même balance)
    const perMinute = new Map<number, Map<string, number>>()
    for (const s of snaps ?? []) {
      const t = Math.floor(new Date(s?.snapshot_at ?? 0).getTime() / 60000) * 60000
      const v = parseFloat(s?.value_usd ?? '0')
      if (!Number.isFinite(v)) continue
      const key = `${s?.chain ?? '?'}|${s?.token ?? '?'}`
      const m = perMinute.get(t) ?? new Map<string, number>()
      m.set(key, v) // les lignes sont triées par date : la dernière écrase la précédente
      perMinute.set(t, m)
    }
    const captures = new Map<number, number>()
    for (const [t, m] of Array.from(perMinute.entries())) {
      let total = 0
      for (const v of Array.from(m.values())) total += v
      captures.set(t, total)
    }

    // 2) Ré-échantillonne à la granularité demandée (dernière capture de chaque tranche)
    const buckets = new Map<number, { t: number; total: number }>()
    for (const [t, total] of Array.from(captures.entries()).sort((a, b) => a[0] - b[0])) {
      const bt = Math.floor(t / bucketMs) * bucketMs
      buckets.set(bt, { t: bt, total })
    }

    const series = Array.from(buckets.values()).sort((a, b) => (a?.t ?? 0) - (b?.t ?? 0))
    return NextResponse.json(series ?? [])
  } catch {
    return NextResponse.json([])
  }
}
