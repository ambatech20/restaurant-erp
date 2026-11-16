export const locales = ['en', 'am', 'om'] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = 'en';

export const localeNames: Record<Locale, string> = {
  en: 'EN',
  am: 'አማ',
  om: 'OM',
};

export const localeLongNames: Record<Locale, string> = {
  en: 'English',
  am: 'አማርኛ',
  om: 'Afaan Oromoo',
};
