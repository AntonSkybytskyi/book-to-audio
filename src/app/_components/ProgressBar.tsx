import { cx } from "../_lib/cx";

interface Props {
  /** 0 to 1. */
  value: number;
  label: string;
  thin?: boolean;
  /** Full but not finished: the bar pulses instead of sitting at 100%. */
  busy?: boolean;
}

export function ProgressBar({ value, label, thin, busy }: Props) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      className={cx("overflow-hidden rounded-full bg-rule", thin ? "h-1" : "h-2")}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <div
        className={cx(
          "h-full rounded-[inherit] bg-accent transition-[width] duration-600 ease-[ease]",
          busy && "animate-pulse-busy",
        )}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
