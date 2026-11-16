'use client';

import { useLocale, useTranslations } from 'next-intl';
import { formatPrice } from '@/lib/utils';
import { shortOrderNumber } from '@/features/orders/openBills';
import type { OpenBillOption } from '@/features/orders/openBills';
import Icon from '@/components/shared/Icon';

interface OpenBillPickerProps {
  tableNumber: string;
  bills: OpenBillOption[];
  selectedId: number | null;
  loading: boolean;
  onSelect: (bill: OpenBillOption | null) => void;
}

/**
 * Lists the table's open bills under the table selector. Selecting a bill turns
 * the cart into a second course on that bill; deselecting turns it back into a
 * new bill.
 */
export default function OpenBillPicker({
  tableNumber,
  bills,
  selectedId,
  loading,
  onSelect,
}: OpenBillPickerProps) {
  const t = useTranslations('pos');
  const to = useTranslations('orders');
  const locale = useLocale();

  if (loading || bills.length === 0) return null;

  return (
    <div
      style={{
        marginTop: 'var(--space-2)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '6px 10px',
          fontSize: '0.75rem',
          fontWeight: 600,
          background: 'var(--bg-input)',
          color: 'var(--text-secondary)',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
        }}
      >
        <Icon name="coins" size={13} />
        {t('openBillsForTable', { number: tableNumber })}
      </div>

      {bills.length > 1 && (
        <div style={{ padding: '6px 10px', fontSize: '0.75rem', color: 'var(--warning)' }}>
          {t('chooseOpenBill')}
        </div>
      )}

      {bills.map((bill) => {
        const selected = bill.id === selectedId;
        return (
          <button
            key={bill.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(selected ? null : bill)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              width: '100%',
              padding: '8px 10px',
              border: 0,
              borderTop: '1px solid var(--border)',
              background: selected ? 'var(--success-glow)' : 'transparent',
              color: 'var(--text-primary)',
              textAlign: 'left',
              cursor: 'pointer',
            }}
          >
            <span style={{ fontWeight: 700 }}>#{shortOrderNumber(bill.orderNumber)}</span>
            <span className="badge" style={{ fontSize: '0.6875rem' }}>
              {to(bill.status.toLowerCase())}
            </span>
            <span style={{ marginLeft: 'auto', fontSize: '0.8125rem', fontWeight: 600 }}>
              {formatPrice(bill.total, locale)}
            </span>
            <span
              style={{
                fontSize: '0.75rem',
                fontWeight: 600,
                color: selected ? 'var(--success)' : 'var(--text-muted)',
              }}
            >
              {selected ? t('deselectBill') : t('selectBill')}
            </span>
          </button>
        );
      })}
    </div>
  );
}
