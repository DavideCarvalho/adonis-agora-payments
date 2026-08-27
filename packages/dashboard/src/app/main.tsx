import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

/**
 * Refetch every 10s. Durable polls at 2s because a run's state changes second-to-second; a billing
 * ledger does not, and a 2s poll here would be five aggregate queries a second against the app's
 * primary database for no new information.
 */
const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchInterval: 10_000, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
