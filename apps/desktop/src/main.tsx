import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { AppErrorBoundary, GlobalErrors } from "./GlobalErrors";
import { installGlobalErrors } from "./errors";
import "./styles.css";

const disposeGlobalErrors = installGlobalErrors();
if (import.meta.hot) import.meta.hot.dispose(disposeGlobalErrors);

const client = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } },
});
// Reading a protected directory can trigger an OS permission prompt. Only
// navigation, explicit refresh, and file mutations should reload its contents.
client.setQueryDefaults(["entries"], {
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
});
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>
    </AppErrorBoundary>
    <GlobalErrors />
  </React.StrictMode>,
);
