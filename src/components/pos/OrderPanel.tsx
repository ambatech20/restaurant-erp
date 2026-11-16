'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useCartStore } from '@/features/orders/store';
import { getLocaleName, formatPrice } from '@/lib/utils';
import { shortOrderNumber, type OpenBillOption } from '@/features/orders/openBills';
import OpenBillPicker from '@/components/pos/OpenBillPicker';
import Icon from '@/components/shared/Icon';
import { allTableNumbers } from '@/lib/tables';

interface OrderPanelProps {
  onPlaceOrder: () => void;
  onPay?: () => void;
  loading?: boolean;
  isWaiter?: boolean;
  tables?: string[];
  openBills?: OpenBillOption[];
  openBillsLoading?: boolean;
  onSelectOpenBill?: (bill: OpenBillOption | null) => void;
  sheetOpen?: boolean;
  onClose?: () => void;
}

export default function OrderPanel({
  onPlaceOrder,
  loading,
  isWaiter,
  tables = allTableNumbers(),
  openBills = [],
  openBillsLoading = false,
  onSelectOpenBill,
  sheetOpen,
  onClose,
}: OrderPanelProps) {
  const t = useTranslations('pos');
  const tc = useTranslations('common');
  const locale = useLocale();

  const items = useCartStore((s) => s.items);
  const orderType = useCartStore((s) => s.orderType);
  const tableNumber = useCartStore((s) => s.tableNumber);
  const appendTarget = useCartStore((s) => s.appendTarget);
  const setOrderType = useCartStore((s) => s.setOrderType);
  const setTableNumber = useCartStore((s) => s.setTableNumber);
  const setAppendTarget = useCartStore((s) => s.setAppendTarget);
  const updateQuantity = useCartStore((s) => s.updateQuantity);
  const removeItem = useCartStore((s) => s.removeItem);
  const clearCart = useCartStore((s) => s.clearCart);

  return (
    <div className={`pos-order-panel ${sheetOpen ? 'open' : ''}`}>
      {/* Order Type Toggle */}
      <div style={{ padding: 'var(--space-3) var(--space-4)', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', gap: 'var(--space-2)', background: 'var(--bg-input)', borderRadius: 'var(--radius-sm)', padding: '3px' }}>
          <button
            className={`btn btn-sm ${orderType === 'DINE_IN' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setOrderType('DINE_IN')}
            style={{ flex: 1 }}
          >
            <Icon name="menu" size={16} /> {t('dineIn')}
          </button>
          <button
            className={`btn btn-sm ${orderType === 'TAKEOUT' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setOrderType('TAKEOUT')}
            style={{ flex: 1 }}
          >
            <Icon name="inventory" size={16} /> {t('takeout')}
          </button>
        </div>

        {/* Takeout Packaging Fee Option */}
        {orderType === 'TAKEOUT' && (
          <div style={{ marginTop: 'var(--space-2)' }}>
            <button 
              className="btn btn-secondary btn-sm w-full"
              style={{ fontSize: '0.8125rem', minHeight: '32px' }}
              onClick={() => {
                const feeStr = window.prompt('Enter custom packaging fee amount (ETB):', '15');
                const fee = feeStr ? parseFloat(feeStr) : Number.NaN;
                if (!Number.isNaN(fee) && fee >= 0) {
                  // Using the Takeaway Packaging item we added (ID 55)
                  useCartStore.getState().addItem({
                    menuItemId: 55,
                    nameEn: 'Takeaway Packaging',
                    nameAm: 'የማሸጊያ ዋጋ',
                    price: fee,
                    overridePrice: fee,
                  });
                }
              }}
            >
              <Icon name="plus" size={16} /> Add Custom Packaging Fee
            </button>
          </div>
        )}

        {/* Table selector */}
        {orderType === 'DINE_IN' && (
          <div style={{ marginTop: 'var(--space-2)' }}>
            <select
              className="input"
              value={tableNumber || ''}
              onChange={(e) => setTableNumber(e.target.value || null)}
              style={{ fontSize: '0.875rem', minHeight: '38px', padding: 'var(--space-2) var(--space-3)' }}
            >
              <option value="">{t('selectTable')}</option>
              {tables.map((tbl) => (
                <option key={tbl} value={tbl}>
                  {t('table', { number: tbl })}
                </option>
              ))}
            </select>

            {tableNumber && (
              <OpenBillPicker
                tableNumber={tableNumber}
                bills={openBills}
                selectedId={appendTarget?.id ?? null}
                loading={openBillsLoading}
                onSelect={(bill) => {
                  setAppendTarget(bill);
                  onSelectOpenBill?.(bill);
                }}
              />
            )}
          </div>
        )}
      </div>

      {/* Append banner: this cart is a second course on an existing bill. */}
      {appendTarget && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            padding: 'var(--space-2) var(--space-4)',
            background: 'var(--success-glow)',
            borderBottom: '1px solid var(--border)',
            fontSize: '0.8125rem',
            fontWeight: 600,
            color: 'var(--success)',
          }}
        >
          <Icon name="plus" size={14} />
          <span style={{ flex: 1 }}>
            {t('addingToOrder', { number: shortOrderNumber(appendTarget.orderNumber) })}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label={t('deselectBill')}
            onClick={() => setAppendTarget(null)}
            style={{ minHeight: '24px', minWidth: '24px', color: 'var(--text-muted)' }}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      )}

      {/* Order Header */}
      <div style={{ padding: 'var(--space-3) var(--space-4)', borderBottom: '1px solid var(--border)' }}>
        <div className="flex-between">
          <h3 style={{ fontSize: '0.9375rem' }}>
            {t('currentOrder')}
            {items.length > 0 && (
              <span style={{ color: 'var(--accent-emerald)', marginLeft: 'var(--space-2)', fontSize: '0.8125rem' }}>
                ({items.reduce((s, i) => s + i.quantity, 0)})
              </span>
            )}
          </h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
            {items.length > 0 && (
              <button className="btn btn-ghost btn-sm" onClick={clearCart} style={{ color: 'var(--danger)', fontSize: '0.75rem' }}>
                {t('clearOrder')}
              </button>
            )}
            <button className="btn btn-ghost btn-icon order-sheet-close" onClick={onClose} aria-label={tc('close')}>
              <Icon name="x" size={20} />
            </button>
          </div>
        </div>
      </div>

      {/* Items List */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {items.length === 0 ? (
          <div className="empty-state" style={{ padding: 'var(--space-10) var(--space-4)' }}>
            <div className="empty-state-icon"><Icon name="cart" size={40} /></div>
            <div className="empty-state-title">{t('emptyCart')}</div>
            <div className="empty-state-desc">{t('emptyCartDesc')}</div>
          </div>
        ) : (
          items.map((item) => {
            const uniqueKey = `${item.menuItemId}-${item.variantId || 'base'}`;
            return (
            <div key={uniqueKey} className="order-item">
              <div className="order-item-details">
                <div className="order-item-name">
                  {getLocaleName(item.nameEn, item.nameAm, locale, item.nameOm)}
                  {item.variantId && (
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginLeft: '6px' }}>
                      ({getLocaleName(item.variantNameEn || '', item.variantNameAm || null, locale, item.variantNameOm || null)})
                    </span>
                  )}
                </div>
                <div className="order-item-price">{formatPrice(item.price, locale)}</div>
              </div>
              <div className="order-item-qty">
                <button className="qty-btn" onClick={() => updateQuantity(item.menuItemId, item.variantId, item.quantity - 1)}>−</button>
                <span className="qty-value">{item.quantity}</span>
                <button className="qty-btn" onClick={() => updateQuantity(item.menuItemId, item.variantId, item.quantity + 1)}>+</button>
              </div>
              <div style={{ minWidth: '70px', textAlign: 'right', fontWeight: 600, fontSize: '0.875rem', whiteSpace: 'nowrap', flexShrink: 0 }}>
                {formatPrice(item.price * item.quantity, locale)}
              </div>
              <button
                className="btn btn-ghost btn-icon"
                onClick={() => removeItem(item.menuItemId, item.variantId)}
                style={{ color: 'var(--danger)', minHeight: '32px', minWidth: '32px' }}
              >
                <Icon name="x" size={16} />
              </button>
            </div>
          )})
        )}
      </div>

      {/* Action Buttons */}
      <div style={{ padding: 'var(--space-3) var(--space-4)', display: 'flex', gap: 'var(--space-2)' }}>
        {isWaiter ? (
          <button
            className="btn btn-primary btn-xl w-full"
            disabled={items.length === 0 || loading || (orderType === 'DINE_IN' && !tableNumber)}
            onClick={onPlaceOrder}
            style={{ flex: 1, background: 'var(--accent-gold)' }}
          >
            {loading ? tc('loading') : (orderType === 'DINE_IN' && !tableNumber && items.length > 0) ? (<><Icon name="alertTriangle" size={18} /> {t('selectTable')}</>) : appendTarget ? (<><Icon name="plus" size={18} /> {t('addToOrder')}</>) : (<><Icon name="kitchen" size={18} /> {t('sendToKitchen')}</>)}
          </button>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', flex: 1 }}>
            {/* Order first: send to the kitchen without taking payment. */}
            <button
              className="btn btn-primary btn-xl"
              disabled={items.length === 0 || loading || (orderType === 'DINE_IN' && !tableNumber)}
              onClick={onPlaceOrder}
              style={{ flex: 1, background: 'var(--accent-gold)' }}
            >
              {loading ? tc('loading') : (orderType === 'DINE_IN' && !tableNumber && items.length > 0) ? (<><Icon name="alertTriangle" size={18} /> {t('selectTable')}</>) : appendTarget ? (<><Icon name="plus" size={18} /> {t('addToOrder')}</>) : (<><Icon name="kitchen" size={18} /> {t('sendToKitchen')}</>)}
            </button>
            {/* Payment is settled later from the Unpaid list. */}
          </div>
        )}
      </div>
    </div>
  );
}
