import App from './App'
import { WorkbenchProvider } from './api'
import { AppBoundary } from './components/AppBoundary'
import './styles.css'
import { MantineProvider, createTheme, localStorageColorSchemeManager } from '@mantine/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

// Material-style tonal theme: neutral grey surfaces, coral as the primary, a light primary on dark surfaces
// (so filled buttons carry dark text there), and full or large radii everywhere.
const theme = createTheme({
  fontFamily: 'Manrope, sans-serif',
  fontFamilyMonospace: 'JetBrains Mono, monospace',
  headings: { fontFamily: 'Manrope, sans-serif', fontWeight: '700' },
  primaryColor: 'coral',
  primaryShade: { light: 7, dark: 2 },
  autoContrast: true,
  defaultRadius: 'md',
  radius: { xs: '6px', sm: '10px', md: '14px', lg: '20px', xl: '32px' },
  colors: {
    coral: ['#fff0ed', '#ffdad4', '#ffb4a8', '#ff8f80', '#f86657', '#e05142', '#c9402f', '#b3392b', '#932a1f', '#6f1d15'],
    dark: ['#e6e6e8', '#c8c8cc', '#a9a9af', '#7c7c82', '#404044', '#333336', '#272729', '#1c1c1d', '#121212', '#0c0c0c'],
  },
  components: {
    Button: { defaultProps: { fw: 600, radius: 'xl' } },
    ActionIcon: { defaultProps: { radius: 'xl' } },
    Badge: { defaultProps: { tt: 'none', fw: 600, radius: 'xl' } },
    Checkbox: { defaultProps: { radius: 'xs' } },
    Alert: { defaultProps: { radius: 'lg' } },
    Tooltip: { defaultProps: { radius: 'sm' } },
    Modal: {
      defaultProps: { centered: true, radius: 'lg', transitionProps: { duration: 0 }, closeButtonProps: { 'aria-label': 'Close dialog' } },
    },
  },
})
const client = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } } })
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="dark" colorSchemeManager={localStorageColorSchemeManager({ key: 'v086-docs-theme' })}>
      <QueryClientProvider client={client}>
        <BrowserRouter>
          <WorkbenchProvider>
            <AppBoundary>
              <App />
            </AppBoundary>
          </WorkbenchProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </MantineProvider>
  </React.StrictMode>,
)
