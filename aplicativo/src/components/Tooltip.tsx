import type { ReactNode } from 'react';

import styles from './Tooltip.module.css';

type TooltipProps = {
  label: string;
  children: ReactNode;
};

export default function Tooltip({ label, children }: TooltipProps) {
  return (
    <span className={styles.wrapper} data-tooltip={label} title={label}>
      {children}
    </span>
  );
}
