import type { MetricGuide } from "../../shared/metric.ts";

/**
 * カードの中の小さな推移（古い順の折れ線と最後の点。目安の下限・上限は点線で並べるだけで、判定はしない）。横は枠の幅に合わせて伸ばし
 * （preserveAspectRatio="none"）、線と点は伸ばさない（vector-effect で線 2px・点 8px のまま。点は長さ 0 の線を丸い端で描く）。2 件未満は描かない
 */
export function Sparkline({ series, guide, unit, label }: { series: readonly { at: string; value: number }[]; guide?: MetricGuide; unit?: string; label: string }) {
  if (series.length < 2) return null;
  const nums = series.map((p) => p.value);
  const lines = [guide?.min, guide?.max].filter((n): n is number => n !== undefined);
  const lo = Math.min(...nums, ...lines);
  const hi = Math.max(...nums, ...lines);
  const W = 300;
  const H = 56;
  const P = 6;
  const x = (i: number) => P + (i * (W - 2 * P)) / (series.length - 1);
  const y = (n: number) => (hi === lo ? H / 2 : H - P - ((n - lo) * (H - 2 * P)) / (hi - lo));
  const u = unit ? ` ${unit}` : "";
  const fixed = { vectorEffect: "non-scaling-stroke" as const, strokeLinecap: "round" as const };
  const last = series.length - 1;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-14 w-full text-accent" role="img" aria-label={`${label}の推移（古い順 ${series.length} 件。最小 ${Math.min(...nums)}${u}・最大 ${Math.max(...nums)}${u}）`}>
      {lines.map((n) => (
        <line key={n} x1={P} x2={W - P} y1={y(n)} y2={y(n)} className="stroke-fg-4" strokeWidth={1} strokeDasharray="4 4" {...fixed}>
          <title>{`目安 ${n}${u}`}</title>
        </line>
      ))}
      <polyline points={series.map((p, i) => `${x(i)},${y(p.value)}`).join(" ")} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" {...fixed} />
      <path d={`M${x(last)} ${y(series[last].value)}h0`} stroke="currentColor" strokeWidth={8} {...fixed}>
        <title>{`${series[last].at.slice(0, 16).replace("T", " ")}  ${series[last].value}${u}`}</title>
      </path>
    </svg>
  );
}
