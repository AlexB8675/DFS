import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '@/app/app'
import { createAppRouter } from '@/app/router'
import { initTheme } from '@/lib/theme'
import { enableMocking } from '@/mocks/enable'
import './index.css'

initTheme()

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')

// The router loads the first route as soon as it is created, so the mock API
// must be listening before that.
await enableMocking()
const router = createAppRouter()

createRoot(root).render(
  <StrictMode>
    <App router={router} />
  </StrictMode>,
)
