export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'atlas-theme';

function storedTheme(): Theme {
  if (typeof localStorage === 'undefined') {
    return 'dark';
  }
  if (localStorage.getItem(STORAGE_KEY) === 'light') {
    return 'light';
  }
  return 'dark';
}

class ThemeState {
  value = $state<Theme>(storedTheme());

  toggle(): void {
    this.set(this.value === 'dark' ? 'light' : 'dark');
  }

  set(theme: Theme): void {
    this.value = theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(STORAGE_KEY, theme);
  }

  apply(): void {
    document.documentElement.setAttribute('data-theme', this.value);
  }
}

export const theme = new ThemeState();
