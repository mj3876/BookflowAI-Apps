/**
 * KpiLine — line/area chart (bf-theme · 다중 line 지원).
 *
 * yKey 가 array 면 series 가 여러 개 그려진다. yLabels 로 legend 표기.
 */
import ReactECharts from 'echarts-for-react';
import { useMemo } from 'react';

const BF_COLORS = ['#3B82F6', '#F97316', '#22C55E', '#A855F7', '#EC4899', '#14B8A6', '#EAB308', '#0EA5E9'];
const TOKENS = { text: '#212529', muted: '#6C757D', border: '#DEE2E6', split: '#E9ECEF' };

type Props<T> = {
  data: T[];
  xKey: keyof T;
  yKey: keyof T | (keyof T)[];
  title?: string;
  height?: number;
  smooth?: boolean;
  area?: boolean;
  yLabels?: string[];
  isLoading?: boolean;
};

export default function KpiLine<T extends Record<string, unknown>>({
  data,
  xKey,
  yKey,
  title,
  height = 300,
  smooth = true,
  area = false,
  yLabels,
  isLoading,
}: Props<T>) {
  const yKeys = Array.isArray(yKey) ? yKey : [yKey];
  const labels = yLabels ?? yKeys.map(String);

  const option = useMemo(
    () => ({
      title: title
        ? { text: title, textStyle: { color: TOKENS.text, fontSize: 13, fontWeight: 600 } }
        : undefined,
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#FFFFFF',
        borderColor: TOKENS.border,
        textStyle: { color: TOKENS.text, fontSize: 11 },
      },
      legend:
        yKeys.length > 1
          ? { data: labels, textStyle: { color: TOKENS.muted, fontSize: 11 }, top: title ? 26 : 4 }
          : undefined,
      grid: { left: 50, right: 20, top: title ? 56 : 28, bottom: 30 },
      xAxis: {
        type: 'category',
        data: data.map((d) => d[xKey]),
        axisLine: { lineStyle: { color: TOKENS.border } },
        axisLabel: { color: TOKENS.muted, fontSize: 10 },
      },
      yAxis: {
        type: 'value',
        axisLine: { lineStyle: { color: TOKENS.border } },
        axisLabel: { color: TOKENS.muted, fontSize: 10 },
        splitLine: { lineStyle: { color: TOKENS.split } },
      },
      series: yKeys.map((k, i) => ({
        name: labels[i],
        type: 'line',
        smooth,
        areaStyle: area ? { color: BF_COLORS[i % BF_COLORS.length], opacity: 0.18 } : undefined,
        lineStyle: { color: BF_COLORS[i % BF_COLORS.length], width: 2 },
        itemStyle: { color: BF_COLORS[i % BF_COLORS.length] },
        symbol: 'circle',
        symbolSize: 5,
        data: data.map((d) => d[k]),
      })),
    }),
    [data, xKey, yKey, title, smooth, area, yLabels],
  );

  if (isLoading) {
    return (
      <div
        className="rounded bg-bf-panel2 border border-bf-border2 animate-pulse"
        style={{ height }}
      />
    );
  }
  if (data.length === 0) {
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
