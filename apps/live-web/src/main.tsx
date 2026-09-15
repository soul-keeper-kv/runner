import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './app/App.js';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The Runner returns structured errors; retrying a 400 would only repeat
      // the same contract failure.
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

const container = document.getElementById('root');
if (container === null) throw new Error('Root element not found.');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
