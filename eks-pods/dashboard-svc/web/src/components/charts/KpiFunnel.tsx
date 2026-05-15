/**
 * KpiFunnel — funnel chart bf-theme.
 *
 * data: { name, value }[] — 입력 순서대로 funnel 단계 (예: PENDING → APPROVED → EXECUTED).
 */
import ReactECharts from 'echarts-for-react';
import { useMemo } from 'react';

const BF_COLORS = ['#3B82F6', '#F97316', '#22C55E', '#A855F7', '#EC4899', '#14B8A6'];
const TOKENS = { text: '#212529', muted: '#6C757D', border: '#DEE2E6' };

type FunnelDatum = { name: string; value: number };

type Props = {
  data: FunnelDatum[];
  title?: string;
  height?: number;
  /** 'descending' (default · 위가 큼) | 'ascending' (아래가 큼 · pyramid) */
  sort?: 'descending' | 'ascending' | 'none';
  isLoading?: boolean;
};

export default function KpiFunnel({
  data,
  title,
  height = 300,
  sort = 'none',
  isLoading,
}: Props) {
  const option = useMemo(
    () => ({
      title: title
        ? { text: title, textStyle: { color: TOKENS.text, fontSize: 13, fontWeight: 600 } }
        : undefined,
      tooltip: {
        trigger: 'item',
        backgroundColor: '#FFFFFF',
        borderColor: TOKENS.border,
        textStyle: { color: TOKENS.text, fontSize: 11 },
        formatter: '{b}<br/>{c} ({d}%)',
      },
      legend: {
        data: data.map((d) => d.name),
        textStyle: { color: TOKENS.muted, fontSize: 11 },
        top: title ? 26 : 4,
      },
      color: BF_COLORS,
      series: [
        {
          type: 'funnel',
          left: '10%',
          right: '10%',
          top: title ? 60 : 32,
          bottom: 20,
          sort,
          gap: 2,
          label: { color: TOKENS.text, fontSize: 11, formatter: '{b}: {c}' },
          labelLine: { length: 10, lineStyle: { color: TOKENS.border, width: 1 } },
          itemStyle: { borderColor: '#FFFFFF', borderWidth: 2 },
          emphasis: { label: { fontSize: 13, fontWeight: 600 } },
          data,
        },
      ],
    }),
    [data, title, sort],
  );

  if (isLoading) {
    return (
      <div
        className="rounded bg-bf-panel2 border border-bf-border2 animate-pulse"
        style={{ height }}
      />
    );
  }
  if (data.length === 0 || data.every((d) => d.value === 0)) {
    return (
      <div
        className="rounded bg-bf-panel2 border border-bf-border2 flex items-center justify-center text-bf-muted text-xs"
        style={{ height }}
      >
        데이터 없음
      </div>
    );
  }

  return <ReactECharts option={option} style={{ height }} opts={{ renderer: 'svg' }} />;
}
