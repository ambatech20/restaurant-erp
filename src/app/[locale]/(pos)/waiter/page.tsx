'use client';

import { useCallback, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import CategoryTabs from '@/components/pos/CategoryTabs';
import MenuGrid from '@/components/pos/MenuGrid';
import OrderPanel from '@/components/pos/OrderPanel';
import { getCategories, getMenuItems } from '@/features/menu/actions';
import {
  addItemsToOrder,
  createOrder,
  getOpenBillsForTable,
  getReadyOrders,
  updateOrderStatus,
} from '@/features/orders/actions';
import { useCartStore } from '@/features/orders/store';
import { resolveAppendTarget, shortOrderNumber, type OpenBillOption } from '@/features/orders/openBills';
import { newClientKey } from '@/lib/clientKey';
import { useSocketEmit, useSocketEvent } from '@/hooks/useSocketEvent';
import { formatPrice, getLocaleName } from '@/lib/utils';
import Icon from '@/components/shared/Icon';
import type { OrderView } from '@/features/orders/types';
import { useAsyncEffect } from '@/hooks/useAsyncEffect';
import { getMyTables } from '@/features/tables/actions';

interface Category {
  id: number;
  nameEn: string;
  nameAm: string | null;
  icon: string | null;
  color: string | null;
}

interface MenuItem {
  id: number;
  nameEn: string;
  nameAm: string | null;
  price: number;
  isAvailable: boolean;
  image: string | null;
  category: { nameEn: string; nameAm: string | null; color: string | null };
  variants?: { id: number; nameEn: string; nameAm: string | null; priceOffset: number }[];
}

export default function WaiterPage() {
  const t = useTranslations('pos');
  const locale = useLocale();
  const [categories, setCategories] = useState<Category[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [activeCategory, setActiveCategory] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const [activeView, setActiveView] = useState<'MENU' | 'READY'>('MENU');
  const [readyOrders, setReadyOrders] = useState<OrderView[]>([]);
  const [loadingReady, setLoadingReady] = useState(false);
  const [openBills, setOpenBills] = useState<OpenBillOption[]>([]);
  const [loadingOpenBills, setLoadingOpenBills] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [tables, setTables] = useState<string[]>([]);

  const items = useCartStore((s) => s.items);
  const orderType = useCartStore((s) => s.orderType);
  const tableNumber = useCartStore((s) => s.tableNumber);
  const orderNote = useCartStore((s) => s.orderNote);
  const discount = useCartStore((s) => s.discount);
  const getTotal = useCartStore((s) => s.getTotal);
  const clearCart = useCartStore((s) => s.clearCart);
  const setAppendTarget = useCartStore((s) => s.setAppendTarget);
  const emit = useSocketEmit();

  const loadOpenBills = useCallback(
    async (table: string, clearTarget = false) => {
      // The table may have changed (or the cart cleared) while the request was
      // in flight — never attach a bill to a cart that moved on.
      if (useCartStore.getState().tableNumber !== table) return;
      const result = await getOpenBillsForTable(table);
      if (useCartStore.getState().tableNumber !== table) return;
      if (result.success) {
        const bills = result.bills as OpenBillOption[];
        setOpenBills(bills);
        setAppendTarget(
          clearTarget ? null : resolveAppendTarget(bills, useCartStore.getState().appendTarget),
        );
      }
      setLoadingOpenBills(false);
    },
    [setAppendTarget],
  );

  useAsyncEffect(() => {
    if (orderType !== 'DINE_IN' || !tableNumber) return;
    loadOpenBills(tableNumber);
  }, [orderType, tableNumber, loadOpenBills]);

  const fetchReadyOrders = async () => {
    setLoadingReady(true);
    const result = await getReadyOrders();
    if (result.success) {
      setReadyOrders(result.orders);
    }
    setLoadingReady(false);
  };

  // Load menu data
  useAsyncEffect(async () => {
    async function loadData() {
      const [catResult, itemResult] = await Promise.all([
        getCategories(),
        getMenuItems(),
      ]);
      if (catResult.success) setCategories(catResult.categories as Category[]);
      if (itemResult.success) setMenuItems(itemResult.items as MenuItem[]);
    }
    loadData();
    fetchReadyOrders();
  }, []);

  // Tables this server may open bills on — their own plus the unassigned ones.
  useAsyncEffect(async () => {
    const result = await getMyTables();
    if (result.success) setTables(result.tables);
  }, []);

  useSocketEvent('order:new', () => {
    fetchReadyOrders();
    if (tableNumber) loadOpenBills(tableNumber);
  });
  useSocketEvent('order:status-update', () => {
    fetchReadyOrders();
    if (tableNumber) loadOpenBills(tableNumber);
  });

  // Filter items by category
  const filteredItems = activeCategory
    ? menuItems.filter((item: MenuItem & { categoryId?: number }) => item.categoryId === activeCategory)
    : menuItems;

  // Waiter sends order directly to kitchen (no payment step). With an open
  // bill on the table the same button adds the course to that bill.
  const handleSendToKitchen = async () => {
    if (items.length === 0) return;
    if (orderType === 'DINE_IN' && !tableNumber) {
      setErrorMsg(t('selectTableFirst'));
      setTimeout(() => setErrorMsg(''), 3000);
      return;
    }
    setLoading(true);

    const payloadItems = items.map((item) => ({
      menuItemId: item.menuItemId,
      variantId: item.variantId,
      quantity: item.quantity,
      note: item.note,
      overridePrice: item.overridePrice,
    }));
    const target = useCartStore.getState().appendTarget;

    if (target) {
      const result = await addItemsToOrder(target.id, payloadItems, newClientKey());
      if (result.success) {
        emit('order:new', { orderId: target.id, tableNumber, appended: true });
        emit('order:status-update', { orderId: target.id, status: result.order?.status });
        clearCart();
        setSheetOpen(false);
        setSuccessMsg(t('itemsAddedToOrder', { number: shortOrderNumber(target.orderNumber) }));
        setTimeout(() => setSuccessMsg(''), 4000);
      } else {
        setErrorMsg(result.error || t('sendOrderFailed'));
        setTimeout(() => setErrorMsg(''), 4000);
        if (tableNumber) loadOpenBills(tableNumber, true);
      }
      setLoading(false);
      return;
    }

    const result = await createOrder({
      type: orderType,
      tableNumber: tableNumber || undefined,
      note: orderNote || undefined,
      discount: discount > 0 ? discount : undefined,
      clientKey: newClientKey(),
      items: payloadItems,
    });

    if (result.success) {
      // Emit socket event for kitchen immediately (no payment step for waiter)
      emit('order:new', { orderId: result.order.id, orderType, tableNumber });
      clearCart();
      setSheetOpen(false);
      setSuccessMsg(t('orderSent'));
      setTimeout(() => setSuccessMsg(''), 4000);
    } else {
      if (result.code === 'TABLE_HAS_OPEN_BILL' && tableNumber) loadOpenBills(tableNumber);
      setErrorMsg(result.error || t('sendOrderFailed'));
      setTimeout(() => setErrorMsg(''), 4000);
    }
    setLoading(false);
  };

  const handleMarkDelivered = async (orderId: number) => {
    const result = await updateOrderStatus(orderId, 'SERVED');
    if (result.success) {
      setSuccessMsg(t('orderMarkedServed'));
      setTimeout(() => setSuccessMsg(''), 3000);
      fetchReadyOrders();
      emit('order:status-update', { orderId, status: 'SERVED' });
    }
  };

  return (
    <>
      {/* Waiter header */}
      <div
        className="waiter-banner"
        style={{
          position: 'fixed', top: 'var(--header-height)', left: 0, right: 0, zIndex: 99,
          background: 'var(--accent-gold)', color: 'white',
          padding: 'var(--space-2) var(--space-4)',
          display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
          fontSize: '0.875rem', fontWeight: 600,
          boxShadow: '0 2px 8px rgba(0,0,0,0.2)'
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <Icon name="menu" size={16} /> {t('waiterMode')}
        </span>
        <span className="waiter-banner-hint" style={{ marginLeft: 'auto', opacity: 0.85, fontWeight: 400, fontSize: '0.8rem' }}>
          {t('ordersGoToKitchen')}
        </span>
      </div>

      <div className="pos-layout" style={{ paddingTop: '44px' }}>
        {/* Left Panel - Menu or Ready Orders */}
        <div className="pos-menu-panel" style={{ background: 'var(--bg-primary)' }}>
          {/* View Toggle Bar */}
          <div style={{ display: 'flex', gap: 'var(--space-2)', padding: 'var(--space-4)', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)' }}>
            <button 
              className={`btn ${activeView === 'MENU' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setActiveView('MENU')}
              style={{ flex: 1, borderRadius: 'var(--radius-full)' }}
            >
              <Icon name="bookOpen" size={16} /> {t('menu')}
            </button>
            <button 
              className={`btn ${activeView === 'READY' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => { setActiveView('READY'); fetchReadyOrders(); }}
              style={{ flex: 1, borderRadius: 'var(--radius-full)', position: 'relative', borderColor: activeView === 'READY' ? 'var(--accent-gold)' : 'var(--success)', color: activeView === 'READY' ? 'white' : 'var(--success)' }}
            >
              <Icon name="bell" size={16} /> {t('readyToServe')}
              {readyOrders.length > 0 && (
                <span style={{ position: 'absolute', top: -5, right: -5, background: 'var(--danger)', color: 'white', fontSize: '0.7rem', padding: '2px 6px', borderRadius: '10px', fontWeight: 'bold' }}>
                  {readyOrders.length}
                </span>
              )}
            </button>
          </div>

          {activeView === 'MENU' ? (
            <>
              {/* Category tabs */}
              <CategoryTabs
                categories={categories}
                activeId={activeCategory}
                onSelect={setActiveCategory}
              />

              {/* Menu grid */}
              <MenuGrid items={filteredItems} />
            </>
          ) : (
            <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-4)' }}>
              <h2 style={{ fontSize: '1.25rem', marginBottom: 'var(--space-4)' }}>{t('readyToServe')}</h2>
              {loadingReady ? (
                <div style={{ textAlign: 'center', padding: 'var(--space-8)' }}>{t('loadingOrders')}</div>
              ) : readyOrders.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 'var(--space-8)', color: 'var(--text-muted)' }}>{t('noReadyOrders')}</div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 'var(--space-4)' }}>
                  {readyOrders.map(order => (
                    <div key={order.id} className="glass-card" style={{ padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', border: '2px solid var(--success)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div>
                          <div style={{ fontWeight: 'bold', fontSize: '1.125rem' }}>{order.orderNumber}</div>
                          <div style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                            {new Date(order.updatedAt).toLocaleTimeString()}
                          </div>
                        </div>
                        <div style={{ background: 'var(--success)', color: 'white', padding: '4px 12px', borderRadius: 'var(--radius-sm)', fontSize: '0.875rem', fontWeight: 600 }}>
                          {order.type === 'DINE_IN' ? t('table', { number: order.tableNumber ?? '' }) : t('takeout')}
                        </div>
                      </div>
                      
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                        <Icon name="user" size={14} /> {t('orderedBy')} {getLocaleName(order.staff.name, order.staff.nameAm, locale, order.staff.nameOm)}
                      </div>

                      <div style={{ marginTop: 'var(--space-2)' }}>
                        <ul style={{ paddingLeft: '20px', fontSize: '0.875rem', margin: 0 }}>
                          {order.items.map((item) => (
                            <li key={item.id}>{item.quantity}x {getLocaleName(item.itemNameEn, item.itemNameAm, locale, item.itemNameOm)}</li>
                          ))}
                        </ul>
                      </div>

                      <div style={{ marginTop: 'var(--space-2)', paddingTop: 'var(--space-2)', borderTop: '1px dashed var(--border)' }}>
                        <button className="btn w-full" style={{ background: 'var(--success)', color: 'white' }} onClick={() => handleMarkDelivered(order.id)}>
                          <Icon name="menu" size={16} /> {t('markServed')}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right Panel - Order */}
        <OrderPanel
          onPlaceOrder={handleSendToKitchen}
          onPay={handleSendToKitchen}
          loading={loading}
          isWaiter={true}
          tables={tables}
          openBills={openBills}
          openBillsLoading={loadingOpenBills}
          sheetOpen={sheetOpen}
          onClose={() => setSheetOpen(false)}
        />
      </div>

      {/* Mobile: cart summary opens the order sheet */}
      {items.length > 0 && (
        <button type="button" className="pos-cart-bar" onClick={() => setSheetOpen(true)}>
          <span className="pos-cart-bar-count">{items.reduce((s, i) => s + i.quantity, 0)}</span>
          <span className="pos-cart-bar-label">{t('currentOrder')}</span>
          <span className="pos-cart-bar-total">{formatPrice(getTotal(), locale)}</span>
          <Icon name="chevronRight" size={18} />
        </button>
      )}

      {sheetOpen && <div className="pos-sheet-backdrop" onClick={() => setSheetOpen(false)} />}

      {/* Success Toast */}
      {successMsg && (
        <div className="toast-container">
          <div className="toast toast-success animate-slideInRight">
            <span style={{ color: 'var(--success)' }}><Icon name="checkCircle" size={24} /></span>
            <div>
              <div style={{ fontWeight: 600 }}>{successMsg}</div>
            </div>
          </div>
        </div>
      )}

      {/* Error Toast */}
      {errorMsg && (
        <div className="toast-container">
          <div className="toast toast-error animate-slideInRight">
            <span style={{ color: 'var(--danger)' }}><Icon name="xCircle" size={24} /></span>
            <div>
              <div style={{ fontWeight: 600 }}>{errorMsg}</div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
