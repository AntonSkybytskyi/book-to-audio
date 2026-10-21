import { cx } from "../_lib/cx";
import styles from "./ProgressBar.module.css";

interface Props {
  /** 0 to 1. */
  value: number;
  label: string;
  thin?: boolean;
}

export function ProgressBar({ value, label, thin }: Props) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      className={cx(styles.track, thin && styles.thin)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <div className={styles.fill} style={{ width: `${percent}%` }} />
    </div>
  );
}
