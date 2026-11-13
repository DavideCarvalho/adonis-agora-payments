import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../agora-kit/fonts';
import { ThemeProvider } from '../agora-kit/theme';
import { App, PAYMENTS_ACCENT } from './App';
import { installMockConsoleApi } from './mock-console';
import './index.css';

/**
 * Standalone visual-verification entry (`preview.html`): the WHOLE console against a stubbed
 * `fetch` (see `mock-console.ts`), so every screen can be screenshotted with its real components
 * and styling, with no server. Deep-link a screen the same way the real console does:
 * `preview.html#/disputes`. Not part of the shipped bundle.
 */
installMockConsoleApi();

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchInterval: false, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <ThemeProvider storageKey="agora-payments-theme" accent={PAYMENTS_ACCENT}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
