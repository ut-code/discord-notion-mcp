<script lang="ts">
  import { labelIndexes, niceScale } from "$lib/chart-scale";
  import type { ChartSeries } from "$lib/server/dashboard/stats";

  let { rows, series, label }: { rows: Array<Record<string, string | number>>; series: ChartSeries[]; label: string } = $props();

  // Heights are in px and horizontal positions in %, so the server-rendered SVG is final:
  // nothing is measured or redrawn after hydration.
  const PLOT_HEIGHT = 168;
  const AXIS_HEIGHT = 24;

  const value = (row: Record<string, string | number>, key: string) => Number(row[key] ?? 0);
  const scale = $derived(niceScale(Math.max(0, ...rows.map((row) => series.reduce((sum, entry) => sum + value(row, entry.key), 0)))));
  const y = (amount: number) => PLOT_HEIGHT - (amount / scale.max) * PLOT_HEIGHT;
  const band = $derived(100 / rows.length);
  const columns = $derived(
    rows.map((row) => {
      let base = 0;
      return series.flatMap((entry) => {
        const amount = value(row, entry.key);
        if (amount <= 0) return [];
        const segment = { key: entry.key, color: entry.color, y: y(base + amount), height: y(base) - y(base + amount) };
        base += amount;
        return [segment];
      });
    }),
  );
  const labels = $derived(labelIndexes(rows.length, 8));

  let active = $state<number | null>(null);
  let plotWidth = $state(0);
  let tipWidth = $state(0);
  // Beside the hovered day, on the right when it fits, else on the left; never past the y axis.
  const tip = $derived.by(() => {
    const row = active === null ? undefined : rows[active];
    if (active === null || !row) return null;
    const center = ((active + 0.5) / rows.length) * plotWidth;
    const left = center + 8 + tipWidth <= plotWidth ? center + 8 : Math.max(-32, center - 8 - tipWidth);
    return { row, left };
  });

  function track(event: PointerEvent & { currentTarget: SVGSVGElement }) {
    const box = event.currentTarget.getBoundingClientRect();
    const index = Math.floor(((event.clientX - box.left) / box.width) * rows.length);
    active = index >= 0 && index < rows.length ? index : null;
  }
</script>

<div class="flex flex-col gap-3">
  <div class="chart" role="img" aria-label={label}>
    <div class="y-axis" aria-hidden="true">
      {#each scale.ticks as tick (tick)}
        <span style:top={`${y(tick)}px`}>{tick.toLocaleString("ja-JP")}</span>
      {/each}
    </div>
    <div class="plot" bind:clientWidth={plotWidth}>
      <svg
        width="100%"
        height={PLOT_HEIGHT + AXIS_HEIGHT}
        aria-hidden="true"
        onpointermove={track}
        onpointerdown={track}
        onpointerleave={() => (active = null)}
      >
        {#each scale.ticks as tick (tick)}
          <line class="grid" x1="0" x2="100%" y1={y(tick)} y2={y(tick)} />
        {/each}
        {#if active !== null}
          <rect class="hover" x={`${active * band}%`} width={`${band}%`} y="0" height={PLOT_HEIGHT} />
        {/if}
        {#each columns as segments, index (index)}
          {#each segments as segment (segment.key)}
            <rect x={`${(index + 0.125) * band}%`} width={`${band * 0.75}%`} y={segment.y} height={segment.height} fill={segment.color} />
          {/each}
        {/each}
        {#each labels as tick (tick.index)}
          <text class:wide-only={!tick.narrow} x={`${(tick.index + 0.5) * band}%`} y={PLOT_HEIGHT + 16}>{rows[tick.index]?.date}</text>
        {/each}
      </svg>
      {#if tip}
        <div class="tip" style:left={`${tip.left}px`} bind:offsetWidth={tipWidth} aria-hidden="true">
          <p>{tip.row.date}</p>
          {#each series as entry (entry.key)}
            <div>
              <span class="chart-swatch" style:background={entry.color}></span>
              <span class="name">{entry.label}</span>
              <span class="amount">{value(tip.row, entry.key).toLocaleString("ja-JP")}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
  <ul class="chart-legend">
    {#each series as entry (entry.key)}
      <li><span class="chart-swatch" style:background={entry.color}></span>{entry.label}</li>
    {/each}
  </ul>
</div>

<style>
  .chart {
    display: flex;
    margin-top: 8px;
    container-type: inline-size;
  }
  .y-axis {
    position: relative;
    flex: 0 0 32px;
    height: 168px;
    font-size: 11px;
    line-height: 1;
    color: var(--muted-foreground);
    font-variant-numeric: tabular-nums;
  }
  .y-axis span {
    position: absolute;
    right: 8px;
    transform: translateY(-50%);
  }
  .plot {
    position: relative;
    flex: 1 1 auto;
    min-width: 0;
  }
  svg {
    display: block;
    overflow: visible;
  }
  .grid {
    stroke: var(--border);
  }
  .hover {
    fill: var(--muted);
  }
  text {
    font-size: 11px;
    fill: var(--muted-foreground);
    text-anchor: middle;
  }
  @container (max-width: 520px) {
    .wide-only {
      display: none;
    }
  }
  .tip {
    position: absolute;
    top: 0;
    z-index: 10;
    display: grid;
    gap: 6px;
    min-width: 128px;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--popover);
    color: var(--popover-foreground);
    box-shadow:
      0 20px 25px -5px rgb(0 0 0 / 0.1),
      0 8px 10px -6px rgb(0 0 0 / 0.1);
    font-size: 12px;
    pointer-events: none;
  }
  .tip p {
    margin: 0;
    font-weight: 500;
  }
  .tip div {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .name {
    flex: 1 1 auto;
    color: var(--muted-foreground);
    white-space: nowrap;
  }
  .amount {
    font-family: var(--font-mono);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
</style>
