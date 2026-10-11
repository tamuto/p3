import type { ReactNode } from "react";
import { Badge, cx, Id, type Tone } from "./ui.tsx";

/**
 * 関係の1行。役割の列は幅を決めて、相手・題・理由の始まりがどの行でもそろうようにする。
 *   [役割] [相手の参照  題（長ければ … で切り、マウスで全文。狭い画面では2行まで）]   [右: 確信度・由来・操作]
 *          [理由（あれば次の行。折り返す）]
 * 狭い画面でも列の構成は同じで、題と理由が折り返す・切れるだけ（横にはみ出さない）。
 */
export function RelationRow({
  role,
  tone = "indigo",
  refId,
  onOpen,
  title,
  note,
  aside,
}: {
  role: string;
  tone?: Tone;
  refId: string;
  onOpen?: () => void;
  title?: string;
  note?: string;
  aside?: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[3.75rem_minmax(0,1fr)_auto] items-start gap-x-2 py-1.5">
      <Badge tone={tone} className="mt-0.5 justify-center">
        {role}
      </Badge>
      <div className="min-w-0">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className={cx("shrink-0", refId.includes("/") || refId.length > 6 ? "" : "min-w-[2.75rem]")}>
            <Id id={refId} onClick={onOpen} />
          </span>
          {title && (
            <span className="line-clamp-2 min-w-0 break-words sm:line-clamp-none sm:truncate" title={title}>
              {title}
            </span>
          )}
        </div>
        {note && <p className="text-sm break-words text-slate-600 dark:text-slate-400">{note}</p>}
      </div>
      {aside ? <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">{aside}</div> : <span />}
    </div>
  );
}
