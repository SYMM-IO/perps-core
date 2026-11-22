import App from './App'
import { WorkbenchProvider } from './api'
import { AppBoundary } from './components/AppBoundary'
import './styles.css'
import { Badge, Button, Checkbox, MantineProvider, createTheme, localStorageColorSchemeManager } from '@mantine/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

const statusBadgeTones: Record<string, readonly [fill: string, ink: string]> = {
  teal: ['var(--success-container)', 'var(--on-success-container)'],
  red: ['var(--error-container)', 'var(--on-error-container)'],
  orange: ['var(--warning-container)', 'var(--warn)'],
  yellow: ['var(--warning-container)', 'var(--warn)'],
  blue: ['var(--info-container)', 'var(--on-info-container)'],
  gray: ['var(--secondary-container)', 'var(--on-secondary-container)'],
}

// Compact neutral controls; surfaces and spacing carry hierarchy, with color reserved for actions and state.
const theme = createTheme({
  fontFamily: 'Inter, sans-serif',
  fontFamilyMonospace: 'JetBrains Mono, monospace',
  headings: { fontFamily: 'Inter, sans-serif', fontWeight: '650' },
  primaryColor: 'coral',
  primaryShade: { light: 7, dark: 2 },
  autoContrast: true,
  defaultRadius: 'sm',
  radius: { xs: '4px', sm: '8px', md: '10px', lg: '14px', xl: '20px' },
  colors: {
    coral: ['#fff0ed', '#ffdad4', '#ffb4a8', '#ff8f80', '#f86657', '#e05142', '#c9402f', '#b3392b', '#932a1f', '#6f1d15'],
    dark: ['#e6e6e8', '#c8c8cc', '#a9a9af', '#7c7c82', '#404044', '#333336', '#272729', '#1c1c1d', '#121212', '#0c0c0c'],
  },
  components: {
    Button: Button.extend({
      defaultProps: { fw: 500, radius: 'sm' },
      vars: (theme, { color, variant }) => ({
        root:
          (!variant || variant === 'filled') && (!color || color === theme.primaryColor)
            ? { '--button-color': 'var(--on-primary)' }
            : {},
      }),
    }),
    ActionIcon: { defaultProps: { radius: 'sm' } },
    Badge: Badge.extend({
      defaultProps: { tt: 'none', fw: 600, radius: 'xl' },
      vars: (_theme, { variant, color }) => {
        const tone = variant === 'light' && color ? statusBadgeTones[color] : undefined
        return { root: tone ? { '--badge-bg': tone[0], '--badge-color': tone[1] } : {} }
      },
    }),
    Checkbox: Checkbox.extend({
      defaultProps: { radius: 'xs' },
      vars: (theme, { color, iconColor, variant }) => ({
        root:
          (!variant || variant === 'filled') && !iconColor && (!color || color === theme.primaryColor)
            ? { '--checkbox-icon-color': 'var(--on-primary)' }
            : {},
      }),
    }),
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
