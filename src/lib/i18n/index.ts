import { writable, derived, get } from 'svelte/store';
import { uk } from './uk';
import { ru } from './ru';
import type { TranslationKey } from './uk';

export type { TranslationKey } from './uk';
export type Locale = 'uk' | 'ru';

const STORAGE_KEY = 'o3d_locale';

const dictionaries: Record<Locale, Record<TranslationKey, string>> = { uk, ru };

function loadLocale(): Locale {
  if (typeof window === 'undefined') return 'uk';
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'uk' || saved === 'ru') return saved;
  } catch {}
  return 'uk';
}

function createLocaleStore() {
  const { subscribe, set } = writable<Locale>(loadLocale());
  return {
    subscribe,
    set(value: Locale) {
      set(value);
      if (typeof window !== 'undefined') {
        try { localStorage.setItem(STORAGE_KEY, value); } catch {}
      }
    },
  };
}

/** Persisted current UI language — defaults to Ukrainian. */
export const locale = createLocaleStore();

/**
 * Reactive translator: `$t('some.key')` in a component template re-evaluates
 * whenever `locale` changes, since `t` itself is a derived store. `vars`
 * substitutes `{name}` placeholders in the string.
 */
export const t = derived(locale, ($locale) => {
  const dict = dictionaries[$locale];
  return (key: TranslationKey, vars?: Record<string, string | number>): string => {
    let str = dict[key] ?? dictionaries.uk[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) str = str.replaceAll(`{${k}}`, String(v));
    return str;
  };
});

/**
 * Translate a computed key (a catalog id, a category name, …) that isn't part of
 * the statically-checked TranslationKey union. Falls back to the raw key itself
 * — the neutral, stable identifier it's built from — if no entry exists, so a
 * catalog item can never render as literally blank.
 */
export function td(key: string, vars?: Record<string, string | number>): string {
  return get(t)(key as TranslationKey, vars);
}

export const availableLocales: { value: Locale; labelKey: TranslationKey }[] = [
  { value: 'uk', labelKey: 'lang.uk' },
  { value: 'ru', labelKey: 'lang.ru' },
];
