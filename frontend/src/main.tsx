import React from 'react'
import ReactDOM from 'react-dom/client'
import 'leaflet/dist/leaflet.css'
import App from './App'
import './styles.css'
import './appearance.css'
import './pipi.css'
import { I18nProvider } from './i18n'
import { applyAppearance, loadSavedAppearance } from './utils/appearance'

// Before the first paint, so the window never flashes the default theme.
applyAppearance(loadSavedAppearance())

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>
)
