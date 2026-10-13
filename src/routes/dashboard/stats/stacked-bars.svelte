<script lang="ts">
  import { BarChart } from "layerchart";
  import * as Chart from "$lib/components/ui/chart";
  import { useHydrated } from "$lib/hydrated.svelte";
  import type { ChartSeries } from "$lib/server/dashboard/stats";

  let { rows, series, label }: { rows: Array<Record<string, string | number>>; series: ChartSeries[]; label: string } = $props();

  // The server renders a fixed-size SVG that scales with its box (no JavaScript needed);
  // after hydration the chart measures its container instead. The SSR handling (here and
  // the `.stacked-bars` rules in app.css) was written against layerchart 2.7.0.
  const SSR_WIDTH = 720;
  const HEIGHT = 200;

  const hydration = useHydrated();
  const hydrated = $derived(hydration.current);
  let width = $state(SSR_WIDTH);

  const config = $derived(Object.fromEntries(series.map((entry) => [entry.key, { label: entry.label, color: entry.color }])));
  const ticks = $derived.by(() => {
    const step = Math.ceil(rows.length / (width < 520 ? 4 : 8));
    return rows.filter((_, index) => (rows.length - 1 - index) % step === 0).map((row) => row.date);
  });
</script>

<div class="flex flex-col gap-3" bind:clientWidth={width}>
  <Chart.Container
    {config}
    class={["stacked-bars aspect-auto w-full", !hydrated && "ssr"]}
    style={hydrated ? `height:${HEIGHT}px` : undefined}
    role="img"
    aria-label={label}
  >
    <BarChart
      data={rows}
      x="date"
      series={series.map((entry) => ({ key: entry.key, label: entry.label, color: entry.color }))}
      seriesLayout="stack"
      ssr
      width={hydrated ? undefined : SSR_WIDTH}
      height={HEIGHT}
      bandPadding={0.25}
      padding={{ top: 8, right: 4, bottom: 24, left: 32 }}
      props={{
        svg: hydrated ? {} : { viewBox: `0 0 ${SSR_WIDTH} ${HEIGHT}` },
        xAxis: { ticks },
        yAxis: { ticks: 4 },
        bars: { stroke: "none" },
        highlight: { area: false },
      }}
    >
      {#snippet tooltip()}
        <Chart.Tooltip />
      {/snippet}
    </BarChart>
  </Chart.Container>
  <!-- Plain HTML legend: layerchart's `legend` prop is not server-rendered and overlaps the x-axis labels. -->
  <ul class="chart-legend">
    {#each series as entry (entry.key)}
      <li><span class="chart-swatch" style:background={entry.color}></span>{entry.label}</li>
    {/each}
  </ul>
</div>
