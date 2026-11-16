'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { usePathname } from '@/i18n/routing';
import { useAuth } from '@/context/AuthProvider';
import { useSocket } from '@/context/SocketProvider';
import { useRouter, Link } from '@/i18n/routing';
import { canAccessPath, canAccessPos } from '@/lib/roles';
import { getLocaleName } from '@/lib/utils';
import LanguageToggle from '@/components/shared/LanguageToggle';
import OfflineBanner from '@/components/shared/OfflineBanner';
import Icon, { type IconName } from '@/components/shared/Icon';

type NavKey = 'overview' | 'orders' | 'menu' | 'shifts' | 'employees' | 'inventory' | 'reports' | 'integrations' | 'reconciliation';

const navItems: { path: string; icon: IconName; labelKey: NavKey }[] = [
  { path: '/overview', icon: 'dashboard', labelKey: 'overview' },
  { path: '/orders', icon: 'orders', labelKey: 'orders' },
  { path: '/menu', icon: 'menu', labelKey: 'menu' },
  { path: '/shifts', icon: 'shifts', labelKey: 'shifts' },
  { path: '/employees', icon: 'employees', labelKey: 'employees' },
  { path: '/inventory', icon: 'inventory', labelKey: 'inventory' },
  { path: '/reports', icon: 'reports', labelKey: 'reports' },
  { path: '/reconciliation', icon: 'chartBar', labelKey: 'reconciliation' },
  { path: '/settings/integrations', icon: 'folder', labelKey: 'integrations' },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations('nav');
  const tc = useTranslations('common');
  const td = useTranslations('dashboard');
  const locale = useLocale();
  const { staff, isReady, logout } = useAuth();
  const { isConnected } = useSocket();
  const pathname = usePathname();
  const router = useRouter();
  const [navOpen, setNavOpen] = useState(false);

  // Not signed in → send to the login screen.
  useEffect(() => {
    if (isReady && !staff) router.replace('/login');
  }, [isReady, staff, router]);

  const handleLogout = () => {
    logout();
    router.push('/login');
  };

  const visibleNav = navItems.filter((item) => canAccessPath(staff?.role, item.path));
  const allowed = staff ? canAccessPath(staff.role, pathname) : false;

  const shell = (content: React.ReactNode) => (
    <div className="pos-view">
      <OfflineBanner />
      <header className="app-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', minWidth: 0 }}>
          <button
            className="btn btn-ghost btn-icon mobile-menu-btn"
            onClick={() => setNavOpen(true)}
            aria-label={t('menu')}
            aria-expanded={navOpen}
          >
            <Icon name="menuList" size={22} />
          </button>
          <div className="app-logo">
            <img src="/logo.png" alt="Mesob" style={{ height: '40px', width: 'auto', objectFit: 'contain' }} />
            <span className="app-name" style={{ fontSize: '1.25rem' }}>{tc('appName')}</span>
            <span className="app-context" style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginLeft: 'var(--space-2)' }}>
              {td('dashboard')}
            </span>
          </div>
        </div>
        <div className="header-actions">
          <div className="connection-status">
            <div className={`connection-dot ${isConnected ? 'connected' : 'disconnected'}`} />
          </div>
          {staff && (
            <span className="header-staff" style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
              <Icon name="user" size={16} /> {getLocaleName(staff.name, staff.nameAm, locale, staff.nameOm)}
            </span>
          )}
          {canAccessPos(staff?.role, 'cashier') && (
            <Link href="/cashier" className="header-quick" style={{ textDecoration: 'none' }}>
              <button className="btn btn-secondary btn-sm"><Icon name="cashier" size={16} /> <span className="header-label">{t('cashier')}</span></button>
            </Link>
          )}
          {canAccessPos(staff?.role, 'kitchen') && (
            <Link href="/kitchen" className="header-quick" style={{ textDecoration: 'none' }}>
              <button className="btn btn-secondary btn-sm"><Icon name="kitchen" size={16} /> <span className="header-label">{t('kitchen')}</span></button>
            </Link>
          )}
          <LanguageToggle />
          <button className="btn btn-ghost btn-sm" onClick={handleLogout} aria-label={tc('logout')}><Icon name="logout" size={18} /></button>
        </div>
      </header>

      <div className="app-shell">
        {/* Sidebar */}
        <nav className={`sidebar ${navOpen ? 'open' : ''}`}>
          {visibleNav.map((item) => (
            <Link key={item.path} href={item.path} style={{ textDecoration: 'none' }} onClick={() => setNavOpen(false)}>
              <div className={`sidebar-item ${pathname === item.path ? 'active' : ''}`}>
                <span className="icon"><Icon name={item.icon} size={20} /></span>
                <span>{t(item.labelKey)}</span>
              </div>
            </Link>
          ))}

          {(canAccessPos(staff?.role, 'cashier') || canAccessPos(staff?.role, 'kitchen')) && (
            <div className="sidebar-quick">
              {canAccessPos(staff?.role, 'cashier') && (
                <Link href="/cashier" style={{ textDecoration: 'none' }} onClick={() => setNavOpen(false)}>
                  <div className="sidebar-item"><span className="icon"><Icon name="cashier" size={20} /></span><span>{t('cashier')}</span></div>
                </Link>
              )}
              {canAccessPos(staff?.role, 'kitchen') && (
                <Link href="/kitchen" style={{ textDecoration: 'none' }} onClick={() => setNavOpen(false)}>
                  <div className="sidebar-item"><span className="icon"><Icon name="kitchen" size={20} /></span><span>{t('kitchen')}</span></div>
                </Link>
              )}
            </div>
          )}
        </nav>
        <div className={`sidebar-backdrop ${navOpen ? 'show' : ''}`} onClick={() => setNavOpen(false)} />

        {/* Main content */}
        <main className="app-main">
          {content}
        </main>
      </div>
    </div>
  );

  // Session is still being restored — render the shell without content to avoid a flash.
  if (!isReady) return shell(null);

  if (!staff) {
    return (
      <div className="empty-state" style={{ minHeight: 'calc(100vh - var(--footer-height))' }}>
        <div className="empty-state-icon"><Icon name="lock" size={48} /></div>
        <div className="empty-state-title">{tc('goToLogin')}</div>
      </div>
    );
  }

  if (!allowed) {
    return shell(
      <div className="empty-state" style={{ minHeight: '40vh' }}>
        <div className="empty-state-icon"><Icon name="lock" size={48} /></div>
        <div className="empty-state-title">{tc('notAuthorized')}</div>
        <div className="empty-state-desc">{tc('notAuthorizedDesc')}</div>
      </div>
    );
  }

  return shell(children);
}
