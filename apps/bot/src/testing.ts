import { Packer } from './packer.ts'
import { storeAllStagedBlobs, type UploaderDeps } from './uploader.ts'

/**
 * What the leading bot does over time, done at once: pack every waiting
 * frame, then store every staged blob. Tests only.
 */
export async function settleBlobs(
  deps: UploaderDeps & { sizes: { blobMaxBytes: number; packTargetBytes: number } },
): Promise<void> {
  const { db, staging, sizes } = deps
  await new Packer({ db, staging, sizes, maxWaitMs: 0 }).sealDue({ force: true })
  await storeAllStagedBlobs(deps)
}
