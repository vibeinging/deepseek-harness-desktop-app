import { createBrowserRouter } from 'react-router-dom'
import { routeObjects } from './routes'
import { setNavigate } from './navigation'

export const router = createBrowserRouter(routeObjects)

// Inject navigate for non-component contexts like store, axios, and guards.
setNavigate((to, opts) => router.navigate(to, opts))

export { constantRoutes } from './routes'
