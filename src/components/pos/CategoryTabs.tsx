'use client';

import { useLocale, useTranslations } from 'next-intl';
import { getLocaleName } from '@/lib/utils';
import Icon from '@/components/shared/Icon';

interface Category {
  id: number;
  nameEn: string;
  nameAm: string | null;
  nameOm?: string | null;
  icon: string | null;
  color: string | null;
}

interface CategoryTabsProps {
  categories: Category[];
  activeId: number | null;
  onSelect: (id: number | null) => void;
}

export default function CategoryTabs({ categories, activeId, onSelect }: CategoryTabsProps) {
  const locale = useLocale();
  const t = useTranslations('common');

  return (
    <div className="category-tabs scrollbar-hide" style={{ flexShrink: 0 }}>
      <button
        className={`category-tab ${activeId === null ? 'active' : ''}`}
        onClick={() => onSelect(null)}
      >
        <Icon name="menu" size={16} /> {t('all')}
      </button>
      {categories.map((cat) => (
        <button
          key={cat.id}
          className={`category-tab ${activeId === cat.id ? 'active' : ''}`}
          onClick={() => onSelect(cat.id)}
        >
          {cat.icon && <span>{cat.icon}</span>} {getLocaleName(cat.nameEn, cat.nameAm, locale, cat.nameOm)}
        </button>
      ))}
    </div>
  );
}
