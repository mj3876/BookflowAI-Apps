/**
 * KpiHeatmap — echarts native heatmap bf-theme.
 *
 * data: { x, y, value }[] — x/y 는 string 또는 number (xLabels/yLabels index 매칭).
 * xLabels · yLabels 가 명시되면 그 순서로 정렬, 아니면 data 에서 unique 추출.
 */
import ReactECharts from 'echarts-for-react';
import { useMemo } from 'react';

const TOKENS = { text: '#212529', muted: '#6C757D', border: '#DEE2E6' };

type HeatCell = { x: string | number; y: string | number; value: number };

type Props = {
  data: HeatCell[];
  xLabels?: (string | number)[];
  yLabels?: (string | number)[];
  title?: string;
  height?: number;
  /** value range — 색 스케일 (default 자동 min/max) */
  min?: number;
  max?: number;
  isLoading?: boolean;
};

export default function KpiHeatmap({
  data,
  xLabels,
  yLabels,
  title,
  height = 300,
  min,
  max,
  isLoading,
}: Props) {
  const option = useMemo(() => {
    const xs = xLabels ?? Array.from(new Set(data.map((d) => d.x)));
    const ys = yLabels ?? Array.from(new Set(data.map((d) => d.y)));
    const xIdx = new Map(xs.map((v, i) => [String(v), i]));
    const yIdx = new Map(ys.map((v, i) => [String(v), i]));

    const series = data
      .map((d) => {
        const xi = xIdx.get(String(d.x));
        const yi = yIdx.get(String(d.y));
        if (xi === undefined || yi === undefined) return null;
        return [xi, yi, d.value];
      })
      .filter(Boolean) as [number, number, number][];

    const values = data.map((d) => d.value);
    const autoMin = values.length ? Math.min(...values) : 0;
    const autoMax = values.length ? Math.max(...values) : 1;

    return {
      title: title
        ? { text: title, textStyle: { color: TOKENS.text, fontSize: 13, fontWeight: 600 } }
        : undefined,
      tooltip: {
        position: 'top',
        backgroundColor: '#FFFFFF',
        borderColor: TOKENS.border,
        textStyle: { color: TOKENS.text, fontSize: 11 },
        formatter: (p: { data: [number, number, number] }) =>
          `${xs[p.data[0]]} · ${ys[p.data[1]]}<br/>값: ${p.data[2]}`,
      },
      grid: { left: 90, right: 30, top: title ? 56 : 28, bottom: 50 },
      xAxis: {
        type: 'category',
        data: xs,
        splitArea: { show: true },
        axisLine: { lineStyle: { color: TOKENS.border } },
        axisLabel: { color: TOKENS.muted, fontSize: 10, interval: 0, rotate: 30 },
      },
      yAxis: {
        type: 'category',
        data: ys,
        splitArea: { show: true },
        axisLine: { lineStyle: { color: TOKENS.border } },
        axisLabel: { color: TOKENS.muted, fontSize: 10 },
      },
      visualMap: {
        min: min ?? autoMin,
        max: max ?? autoMax,
        calculable: true,
        orient: 'horizontal',
        left: 'center',
        bottom: 8,
        textStyle: { color: TOKENS.muted, fontSize: 10 },
        inRange: { color: ['#DBEAFE', '#3B82F6', '#1D4ED8'] },
      },
      series: [
        {
          type: 'heatmap',
          data: series,
          label: { show: false },
          emphasis: { itemStyle: { borderColor: TOKENS.text, borderWidth: 1 } },
        },
      ],
    };
  }, [data, xLabels, yLabels, title, min, max]);

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
