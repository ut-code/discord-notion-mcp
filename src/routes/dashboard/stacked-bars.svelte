<script lang="ts">
  import { labelIndexes, niceScale } from "#lib/chart-scale.js";
  import { formatNumber } from "#lib/locale.js";
  import { m } from "#lib/paraglide/messages.js";
  import type { ChartRow, ChartSeries } from "#lib/server/dashboard/stats.js";

  let { rows, series, label }: { rows: ChartRow[]; series: ChartSeries[]; label: string } = $props();

  // Plain SVG rather than a chart library: layerchart (behind shadcn-svelte's chart) built a
  // component per bar and froze the page for over a second with a few hundred bars.
  // Heights are in px and horizontal positions in %, so the server-rendered SVG is final:
  // nothing is measured or redrawn after hydration.
  const PLOT_HEIGHT = 168;
  /** Band below the plot holding the date labels. */
  const AXIS_HEIGHT = 24;
  const LABEL_BASELINE = PLOT_HEIGHT + 16;
  const Y_AXIS_WIDTH = 32;
  /** Share of a day's band the bar fills; the rest is the gap, split on both sides. */
  const BAR_SHARE = 0.75;
  const MAX_LABELS = 8;
  /** Space between the hovered bar and the tooltip. */
  const TIP_OFFSET = 8;

  const count = (row: ChartRow, key: string) => row.counts[key] ?? 0;
  const scale = $derived(niceScale(Math.max(0, ...rows.map((row) => series.reduce((sum, entry) => sum + count(row, entry.key), 0)))));
  const y = (amount: number) => PLOT_HEIGHT - (amount / scale.max) * PLOT_HEIGHT;
  const band = $derived(100 / rows.length);
  const columns = $derived(
    rows.map((row) => {
      let base = 0;
      return series.flatMap((entry) => {
        const amount = count(row, entry.key);
        if (amount <= 0) return [];
        const segment = { key: entry.key, color: entry.color, y: y(base + amount), height: y(base) - y(base + amount) };
        base += amount;
        return [segment];
      });
    }),
  );
  const labels = $derived(labelIndexes(rows.length, MAX_LABELS));

  let active = $state<number | null>(null);
  let plotWidth = $state(0);
  let tipWidth = $state(0);
  // Beside the hovered day, on the right when it fits, else on the left; it may cover the
  // y axis but not go past the chart's left edge (`left` is relative to the plot).
  const tip = $derived.by(() => {
    const row = active === null ? undefined : rows[active];
    if (active === null || !row) return null;
    const center = ((active + 0.5) / rows.length) * plotWidth;
    const left =
      center + TIP_OFFSET + tipWidth <= plotWidth ? center + TIP_OFFSET : Math.max(-Y_AXIS_WIDTH, center - TIP_OFFSET - tipWidth);
    return { row, left };
  });

  function track(event: PointerEvent & { currentTarget: SVGSVGElement }) {
    const box = event.currentTarget.getBoundingClientRect();
    const index = Math.floor(((event.clientX - box.left) / box.width) * rows.length);
    active = index >= 0 && index < rows.length ? index : null;
  }
</script>

<div class="flex flex-col gap-3">
  <!-- Screen readers get the same numbers from the table below. -->
  <div class="chart" aria-hidden="true">
    <div class="y-axis" style:width={`${Y_AXIS_WIDTH}px`} style:height={`${PLOT_HEIGHT}px`}>
      {#each scale.ticks as tick (tick)}
        <span style:top={`${y(tick)}px`}>{formatNumber(tick)}</span>
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
            <rect
              x={`${(index + (1 - BAR_SHARE) / 2) * band}%`}
              width={`${band * BAR_SHARE}%`}
              y={segment.y}
              height={segment.height}
              style:fill={segment.color}
            />
          {/each}
        {/each}
        {#each labels as tick (tick.index)}
          <text class:wide-only={!tick.narrow} x={`${(tick.index + 0.5) * band}%`} y={LABEL_BASELINE}>{rows[tick.index]?.date}</text>
        {/each}
      </svg>
      {#if tip}
        <div class="tip" style:left={`${tip.left}px`} bind:offsetWidth={tipWidth}>
          <p>{tip.row.date}</p>
          {#each series as entry (entry.key)}
            <div>
              <span class="chart-swatch" style:background={entry.color}></span>
              <span class="name">{entry.label}</span>
              <span class="amount">{formatNumber(count(tip.row, entry.key))}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
  <ul class="chart-legend" aria-hidden="true">
    {#each series as entry (entry.key)}
      <li><span class="chart-swatch" style:background={entry.color}></span>{entry.label}</li>
    {/each}
  </ul>
  <table class="sr-only">
    <caption>{label}</caption>
    <thead>
      <tr>
        <th scope="col">{m.stats_date()}</th>
        {#each series as entry (entry.key)}<th scope="col">{entry.label}</th>{/each}
      </tr>
    </thead>
    <tbody>
      {#each rows as row (row.date)}
        <tr>
          <th scope="row">{row.date}</th>
          {#each series as entry (entry.key)}<td>{formatNumber(count(row, entry.key))}</td>{/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .chart {
    display: flex;
    margin-top: 8px;
    container-type: inline-size;
  }
  .y-axis {
    position: relative;
    flex: none;
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
