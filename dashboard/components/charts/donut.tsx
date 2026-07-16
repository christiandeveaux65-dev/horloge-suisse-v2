'use client'

import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend } from 'recharts'

interface Props {
  data: { name: string; value: number; color: string }[]
  height?: number
}

export default function Donut({ data, height = 260 }: Props) {
  const rows = (data ?? []).filter((d) => (d?.value ?? 0) > 0)
  return (
    <div style={{ width: '100%', height }} role="img" aria-label="Graphique en anneau de répartition">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={rows}
            dataKey="value"
            nameKey="name"
            innerRadius="55%"
            outerRadius="80%"
            paddingAngle={2}
            animationDuration={800}
          >
            {rows.map((d, i) => (
              <Cell key={i} fill={d?.color ?? '#2dd4a7'} stroke="transparent" />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{ backgroundColor: '#11131a', border: '1px solid #262a3b', borderRadius: 8, fontSize: 11 }}
            formatter={(v: any) => `$${Number(v ?? 0).toLocaleString('fr-FR', { maximumFractionDigits: 2 })}`}
          />
          <Legend verticalAlign="top" wrapperStyle={{ fontSize: 11 }} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  )
}
