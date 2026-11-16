'use client';

import { useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useAuth } from '@/context/AuthProvider';
import { useSocket } from '@/context/SocketProvider';
import { useRouter, Link } from '@/i18n/routing';
import { getLocaleName } from '@/lib/utils';
import LanguageToggle from '@/components/shared/LanguageToggle';
import OfflineBanner from '@/components/shared/OfflineBanner';
import Icon from '@/components/shared/Icon';
import EndShiftModal from '@/features/auth/components/EndShiftModal';

export default function PosLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations('common');
  const tn = useTranslations('nav');
  const ts = useTranslations('shift');
  const { staff, shift, logout } = useAuth();
  const { isConnected } = useSocket();
  const router = useRouter();
  const locale = useLocale();
  const [showEndShift, setShowEndShift] = useState(false);

  const handleLogout = () => {
    logout();
    router.push('/login');
  };

  const isManager = staff?.role === 'MANAGER' || staff?.role === 'ADMIN';
  const isWaiter = staff?.role === 'WAITER';

  return (
    <div className="pos-view">
      <OfflineBanner />
      <header className="app-header">
        <div className="app-logo">
          <img src="/logo.png" alt="Mesob" style={{ height: '40px', width: 'auto', objectFit: 'contain' }} />
          <span className="app-name" style={{ fontSize: '1.25rem' }}>{t('appName')}</span>
        </div>

        <div className="header-actions">
          {/* Connection status */}
          <div className="connection-status">
            <div className={`connection-dot ${isConnected ? 'connected' : 'disconnected'}`} />
          </div>

          {/* Staff info */}
          {staff && (
            <div className="header-staff">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                <Icon name="user" size={16} /> {getLocaleName(staff.name, staff.nameAm, locale, staff.nameOm)}
              </span>
            </div>
          )}

          {/* Back to Dashboard (for managers) */}
          {isManager && (
            <Link href="/overview" style={{ textDecoration: 'none' }}>
              <button className="btn btn-secondary btn-sm"><Icon name="dashboard" size={16} /> <span className="header-label">{tn('backToDashboard')}</span></button>
            </Link>
          )}

          {/* End Shift button (for cashiers with active shift) */}
          {shift && !isWaiter && (
            <button className="btn btn-secondary btn-sm" onClick={() => setShowEndShift(true)} style={{ borderColor: 'var(--warning)' }}>
              <Icon name="stop" size={16} /> <span className="header-label">{ts('endShift')}</span>
            </button>
          )}

          <LanguageToggle />

          <button className="btn btn-ghost btn-sm" onClick={handleLogout} title="Logout" aria-label="Logout">
            <Icon name="logout" size={18} />
          </button>
        </div>
      </header>
      {children}

      {/* End Shift Modal */}
      {showEndShift && shift && (
        <EndShiftModal
          shiftId={shift.id}
          onClose={() => setShowEndShift(false)}
          onComplete={() => {
            setShowEndShift(false);
            router.push('/login');
          }}
        />
      )}
    </div>
  );
}
