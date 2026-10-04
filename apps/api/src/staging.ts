import type { FastifyInstance } from 'fastify'

/**
 * Removes the staged frames of versions that no longer exist, after the
 * transaction that removed them committed. A failure only leaves files
 * behind, so it is logged rather than surfaced.
 */
export async function removeStagedVersions(
  app: FastifyInstance,
  versionIds: readonly string[],
): Promise<void> {
  for (const versionId of versionIds) {
    try {
      await app.staging.removeVersion(versionId)
    } catch (error) {
      app.log.warn({ err: error, versionId }, 'could not remove staged frames')
    }
  }
}
