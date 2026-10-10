import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import i18n from '../i18n';

// Tests assert on the English strings, whatever language jsdom reports.
void i18n.changeLanguage('en');

afterEach(() => {
  cleanup();
});
