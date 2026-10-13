import {
  deviceListSchema,
  deviceMeSchema,
  deviceTokenRequestSchema,
  deviceTokenSchema,
  pairDeviceSchema,
  pairingCodeSchema,
  type DeviceMe,
} from '@dfs/shared'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { requireAuth, requireDevice } from '../auth/access.ts'
import { createPairing, listDevices, redeemPairing, removeDevice } from '../devices/devices.ts'

const byId = z.object({ id: z.uuid() })
const noContent = { 204: z.null() }

/** `/api/devices/*` (DESIGN.md §7.6): pairing a backup app, and the user's devices. */
export function devicesRoutes(app: FastifyInstance, _options: object, done: () => void): void {
  const routes = app.withTypeProvider<ZodTypeProvider>()

  // The signed-in user approves a backup app, from the page the app opened.
  routes.post(
    '/devices/pair',
    { schema: { body: pairDeviceSchema, response: { 201: pairingCodeSchema } } },
    async (request, reply) => {
      const pairing = await createPairing(app, requireAuth(request.auth), request.body)
      return reply.code(201).header('cache-control', 'no-store').send(pairing)
    },
  )

  // The app itself, with no session and no Origin: it is no browser. The code
  // and the verifier are the proof, and failures are limited per address.
  routes.post(
    '/devices/token',
    {
      config: { access: 'public' },
      schema: { body: deviceTokenRequestSchema, response: { 201: deviceTokenSchema } },
    },
    async (request, reply) => {
      const paired = await redeemPairing(app, request.body, {
        ip: request.ip,
        agent: request.headers['user-agent'] ?? null,
      })
      // The only time the token is shown: no copy for a cache to keep.
      return reply.code(201).header('cache-control', 'no-store').send(paired)
    },
  )

  routes.get('/devices', { schema: { response: { 200: deviceListSchema } } }, (request) =>
    listDevices(app, requireAuth(request.auth)),
  )

  routes.delete(
    '/devices/:id',
    { schema: { params: byId, response: noContent } },
    async (request, reply) => {
      await removeDevice(app, requireAuth(request.auth), request.params.id)
      return reply.code(204).send(null)
    },
  )

  // What a device token is: who it signs in as, for the app to check.
  routes.get(
    '/devices/me',
    { config: { access: 'device' }, schema: { response: { 200: deviceMeSchema } } },
    (request): DeviceMe => {
      const device = requireDevice(request.device)
      const { user } = device
      return {
        device: { id: device.deviceId, name: device.deviceName },
        user: { id: user.id, username: user.username, displayName: user.displayName },
      }
    },
  )

  done()
}
