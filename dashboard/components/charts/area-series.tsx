'use client'

import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip } from 'recharts'
import { fmtDateShort, fmtDate } from '@/lib/format'

const timeFmt = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' })

interface Props {
  data: { t: number; total: number }[]
  color?: string
  height?: number
}

export default function AreaSeries({ data, color = '#2dd4a7', height = 260 }: Props) {
  // Axe X adaptatif : heures si la série couvre moins de 48 h, sinon jour/mois
  const pts = data ?? []
  const spanMs = pts.length > 1 ? (pts[pts.length - 1]?.t ?? 0) - (pts[0]?.t ?? 0) : 0
  const shortSpan = spanMs > 0 && spanMs <= 48 * 3600 * 1000
  const rows = pts.map((d) => ({
    ...d,
    label: shortSpan ? timeFmt.format(new Date(d?.t ?? 0)) : fmtDateShort(d?.t),
  }))
  return (
    <div style={{ width: '100%', height }} role="img" aria-label="Graphique de l'évolution du portefeuille">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
          <defs>
            <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <XAxis dataKey="label" tickLine={false} tick={{ fontSize: 10 }} interval="preserveStartEnd" stroke="#3f4356" />
          <YAxis
            tickLine={false}
            tick={{ fontSize: 10 }}
            stroke="#3f4356"
            domain={['auto', 'auto']}
            tickFormatter={(v: any) => `$${Math.round(v ?? 0).toLocaleString('fr-FR')}`}
            width={70}
          />
          <Tooltip
            contentStyle={{ backgroundColor: '#11131a', border: '1px solid #262a3b', borderRadius: 8, fontSize: 11 }}
            formatter={(v: any) => [`$${Number(v ?? 0).toLocaleString('fr-FR', { maximumFractionDigits: 2 })}`, 'Valeur']}
            labelFormatter={(_: any, payload: any) => fmtDate(payload?.[0]?.payload?.t)}
          />
          <Area type="monotone" dataKey="total" stroke={color} strokeWidth={2} fill="url(#areaFill)" animationDuration={800} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
