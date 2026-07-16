'use client'

import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, Cell } from 'recharts'

interface Props {
  data: Record<string, any>[]
  bars: { key: string; color: string; label?: string }[]
  height?: number
  yFormatter?: (v: any) => string
  colorByValue?: boolean
}

export default function Bars({ data, bars, height = 300, yFormatter, colorByValue = false }: Props) {
  return (
    <div style={{ width: '100%', height }} role="img" aria-label="Graphique en barres">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data ?? []} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
          <XAxis dataKey="label" tickLine={false} tick={{ fontSize: 10 }} interval="preserveStartEnd" stroke="#3f4356" />
          <YAxis
            tickLine={false}
            tick={{ fontSize: 10 }}
            stroke="#3f4356"
            tickFormatter={yFormatter ?? ((v: any) => `${v}`)}
            width={64}
          />
          <Tooltip
            contentStyle={{ backgroundColor: '#11131a', border: '1px solid #262a3b', borderRadius: 8, fontSize: 11 }}
            cursor={{ fill: 'rgba(255,255,255,0.04)' }}
          />
          <Legend verticalAlign="top" wrapperStyle={{ fontSize: 11 }} />
          {(bars ?? []).map((b) => (
            <Bar key={b?.key} dataKey={b?.key} name={b?.label ?? b?.key} fill={b?.color ?? '#2dd4a7'} radius={[4, 4, 0, 0]} animationDuration={800}>
              {colorByValue
                ? (data ?? []).map((d, i) => (
                    <Cell key={i} fill={(d?.[b?.key] ?? 0) >= 0 ? '#2dd4a7' : '#f87171'} />
                  ))
                : null}
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
