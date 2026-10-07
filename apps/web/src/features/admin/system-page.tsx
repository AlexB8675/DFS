import type { SystemInfo } from '@dfs/shared'
import { useQuery } from '@tanstack/react-query'
import { CircleCheck, CircleHelp, CircleMinus, Eraser, TriangleAlert, Wrench } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { errorMessage } from '@/lib/api/client'
import { appRelease } from '@/lib/env'
import { formatBytes, formatDate, formatFullDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { isFinished, systemQuery, tasksQuery, useClearFrameCache, useStartTask } from './api'
import { Section } from './section'
import { useTaskResults } from './task-results'

const GROUPS: SystemInfo['settings'][number]['group'][] = [
  'General',
  'Storage',
  'Disks',
  'Accounts',
  'Durability',
]

/** A setting or secret only one service reads. */
const ONLY: Record<SystemInfo['settings'][number]['usedBy'], string | null> = {
  api: 'API only',
  bot: 'bot only',
  both: null,
}

const KINDS: Record<SystemInfo['discord']['channels'][number]['kind'], string> = {
  data: 'Storage',
  journal: 'Journal',
  backup: 'Backups',
  log: 'Log',
}

/**
 * `/admin/system`: what this DFS is and how it is set up (§15): its Discord
 * layout, its disks with the frame cache to clear, the settings in effect as
 * the service reading each has it (the bot's too, where both read one and
 * they differ), and whether its secrets are set.
 */
export function SystemPage() {
  const system = useQuery(systemQuery)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid max-w-6xl gap-6 p-4 sm:p-6">
        {system.data ? (
          <SystemView system={system.data} />
        ) : system.isError ? (
          <p className="text-sm text-muted-foreground">
            The settings couldn’t be read: {errorMessage(system.error)}
          </p>
        ) : (
          <>
            <Skeleton className="h-9 w-2/3 rounded-full" />
            <Skeleton className="h-48 rounded-xl" />
          </>
        )}
      </div>
    </div>
  )
}

function SystemView({ system }: { system: SystemInfo }) {
  const blobStore = system.settings.find((setting) => setting.key === 'BLOB_STORE')?.value
  const differing = system.settings.filter((setting) => setting.botValue !== null)
  const { api, bot } = system.releases
  const deployed = api.deployedAt

  return (
    <>
      <ul className="flex flex-wrap gap-2 text-sm" aria-label="This DFS">
        <Chip label={system.environment} detail={`instance ${system.instanceId}`} />
        <Chip
          label="Version"
          detail={deployed ? `${api.version} · deployed ${formatDate(deployed)}` : api.version}
          title={deployed ? formatFullDate(deployed) : undefined}
        />
        <Chip label="Node.js" detail={system.node} />
        <Chip
          label="API"
          detail={`up since ${formatDate(system.apiStartedAt)}`}
          title={formatFullDate(system.apiStartedAt)}
        />
        <Chip
          label="Blobs"
          detail={blobStore === 'discord' ? 'in Discord' : `${blobStore ?? '?'} store`}
        />
      </ul>

      <VersionsDiffer page={appRelease.version} api={api.version} bot={bot?.version ?? null} />

      {differing.length > 0 && (
        <p className="flex items-start gap-2 rounded-xl border border-status-warning/60 bg-card px-4 py-3 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-status-warning" aria-hidden />
          <span>
            The API and the bot read these differently:{' '}
            {differing.map((setting) => setting.key).join(', ')}. Both read them, so both must have
            the same values.
          </span>
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <DiscordCard system={system} discord={blobStore === 'discord'} />
        <JournalCard journal={system.journal} />
        <DisksCard system={system} />
      </div>

      <Section
        title="Settings"
        description={
          system.botSettings
            ? 'As the service reading each has it; where both read one, the bot’s is shown if it differs. Secrets aren’t listed here.'
            : 'The bot didn’t answer, so those it reads are shown as the API has them, and none are compared.'
        }
      >
        <div className="grid gap-5">
          {GROUPS.map((group) => (
            <div key={group} className="grid gap-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">{group}</h3>
              <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[minmax(0,16rem)_1fr]">
                {system.settings
                  .filter((setting) => setting.group === group)
                  .map((setting) => (
                    <div key={setting.key} className="contents">
                      <dt className="truncate font-mono text-xs leading-6 text-muted-foreground">
                        {setting.key}
                      </dt>
                      <dd className="flex min-w-0 flex-wrap items-center gap-2 leading-6">
                        <span className="font-mono text-xs break-all">{setting.value}</span>
                        {!setting.set && (
                          <span className="text-xs text-muted-foreground">default</span>
                        )}
                        {ONLY[setting.usedBy] && (
                          <span className="text-xs text-muted-foreground">
                            {ONLY[setting.usedBy]}
                          </span>
                        )}
                        {setting.botValue !== null && (
                          <Badge variant="outline" className="text-status-warning">
                            bot: {setting.botValue}
                          </Badge>
                        )}
                      </dd>
                    </div>
                  ))}
              </dl>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="Secrets"
        description="Whether each is set in the service that uses it; their values never leave the server. In development, the unset ones have safe defaults."
      >
        <ul className="grid gap-1.5 text-sm sm:grid-cols-2">
          {system.secrets.map((secret) => (
            <li key={secret.key} className="flex items-center gap-2">
              {secret.set === null ? (
                <CircleHelp className="size-4 text-muted-foreground" aria-hidden />
              ) : secret.set ? (
                <CircleCheck className="size-4 text-status-good" aria-hidden />
              ) : (
                <CircleMinus className="size-4 text-muted-foreground" aria-hidden />
              )}
              <span className="font-mono text-xs">{secret.key}</span>
              <span className="text-xs text-muted-foreground">
                {secret.set === null
                  ? 'unknown: the bot didn’t answer'
                  : secret.set
                    ? 'set'
                    : 'not set'}
                {ONLY[secret.usedBy] && ` · ${ONLY[secret.usedBy] ?? ''}`}
              </span>
            </li>
          ))}
        </ul>
      </Section>
    </>
  )
}

function DiscordCard({ system, discord }: { system: SystemInfo; discord: boolean }) {
  const tasks = useQuery(tasksQuery)
  const start = useStartTask()
  useTaskResults(tasks.data)
  const checking =
    (start.isPending && start.variables.kind === 'discord.setup') ||
    (tasks.data ?? []).some((task) => task.kind === 'discord.setup' && !isFinished(task))

  return (
    <Section
      title="Discord"
      description={
        system.discord.guildId
          ? `Server ${system.discord.guildId}, category “${system.discord.categoryName}”; gateway ${system.discord.gateway ? 'on' : 'off'}.`
          : 'No Discord server is set.'
      }
      action={
        <Button
          variant="outline"
          size="sm"
          disabled={!discord || checking}
          title={discord ? undefined : 'This needs Discord storage.'}
          onClick={() => {
            start.mutate(
              { kind: 'discord.setup' },
              {
                onError: (error) => {
                  toast.error('Couldn’t check the layout', { description: errorMessage(error) })
                },
              },
            )
          }}
        >
          {checking ? <Spinner /> : <Wrench />} Check the layout
        </Button>
      }
    >
      {system.discord.channels.length === 0 ? (
        <p className="text-sm text-muted-foreground">No channel is registered.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="pb-2 font-medium">Channel</th>
              <th className="pb-2 pl-4 font-medium">For</th>
              <th className="hidden pb-2 pl-4 font-medium sm:table-cell">Discord ID</th>
            </tr>
          </thead>
          <tbody>
            {system.discord.channels.map((channel) => (
              <tr key={channel.discordChannelId} className="border-t border-border/60">
                <td className={cn('py-1.5', !channel.enabled && 'text-muted-foreground')}>
                  #{channel.name}
                  {!channel.enabled && ' (no new blobs)'}
                </td>
                <td className="py-1.5 pl-4 text-muted-foreground">{KINDS[channel.kind]}</td>
                <td className="hidden py-1.5 pl-4 font-mono text-xs text-muted-foreground sm:table-cell">
                  {channel.discordChannelId}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  )
}

/** The metadata journal (§8): what reached #dfs-journal, and what waits. */
function JournalCard({ journal }: { journal: SystemInfo['journal'] }) {
  const waiting =
    journal.waitingRecords === 0 && journal.waitingBatches === 0
      ? 'Nothing waits.'
      : `${journal.waitingRecords.toLocaleString()} ${journal.waitingRecords === 1 ? 'change waits' : 'changes wait'} to be sealed, ${journal.waitingBatches.toLocaleString()} ${journal.waitingBatches === 1 ? 'batch' : 'batches'} to be posted.`
  return (
    <Section
      title="Journal"
      description="Every change to accounts, files and folders, sealed into batches about once a minute and posted to #dfs-journal, so the metadata can be rebuilt from Discord."
    >
      <div className="space-y-1 text-sm">
        <p>
          {journal.lastBatch === null || !journal.lastPostedAt ? (
            'No batch posted yet.'
          ) : (
            <>
              Batch {journal.lastBatch.toLocaleString()} posted{' '}
              <time dateTime={journal.lastPostedAt} title={formatFullDate(journal.lastPostedAt)}>
                {formatDate(journal.lastPostedAt).toLowerCase()}
              </time>
              .
            </>
          )}
        </p>
        <p className="text-muted-foreground">{waiting}</p>
        {journal.lastError && <p className="text-destructive">{journal.lastError}</p>}
      </div>
    </Section>
  )
}

function DisksCard({ system }: { system: SystemInfo }) {
  const clear = useClearFrameCache()
  const [confirming, setConfirming] = useState(false)
  const { staging, frameCache } = system

  return (
    <Section title="Disks" description="What waits for Discord, and what is kept from it.">
      <div className="grid gap-4">
        <Usage
          label="Staging"
          dir={staging.dir}
          used={staging.usedBytes}
          max={staging.maxBytes}
          note="Uploads not yet in Discord. Uploads pause when it is full."
        />
        {frameCache ? (
          <div className="grid gap-2">
            <Usage
              label="Frame cache"
              dir={frameCache.dir}
              used={frameCache.usedBytes}
              max={frameCache.maxBytes}
              note={`${frameCache.frames.toLocaleString()} frames read back from Discord, on this API instance.`}
            />
            <Button
              variant="outline"
              size="sm"
              className="justify-self-start"
              disabled={clear.isPending || frameCache.usedBytes === 0}
              onClick={() => {
                setConfirming(true)
              }}
            >
              {clear.isPending ? <Spinner /> : <Eraser />} Clear the cache
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No frame cache: blobs are read from local files.
          </p>
        )}
      </div>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear the frame cache?</AlertDialogTitle>
            <AlertDialogDescription>
              Every cached frame goes. Nothing is lost: files are read from Discord again as they
              are downloaded, a little slower until the cache fills up.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                clear.mutate(undefined, {
                  onSuccess: ({ freedBytes }) => {
                    toast.success(`Cleared the frame cache: ${formatBytes(freedBytes)} freed`)
                  },
                  onError: (error) => {
                    toast.error('Couldn’t clear the cache', { description: errorMessage(error) })
                  },
                })
              }}
            >
              Clear it
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  )
}

function Usage({
  label,
  dir,
  used,
  max,
  note,
}: {
  label: string
  dir: string
  used: number
  max: number
  note: string
}) {
  const ratio = max === 0 ? 0 : used / max
  return (
    <div className="grid gap-1.5 text-sm">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground tabular-nums">
          {formatBytes(used)} of {formatBytes(max)}
        </span>
      </p>
      <Progress
        value={Math.min(100, ratio * 100)}
        aria-label={`${label} used`}
        className={cn(
          'h-1.5',
          ratio > 0.8 && '[&_[data-slot=progress-indicator]]:bg-status-warning',
        )}
      />
      <p className="text-xs text-muted-foreground">{note}</p>
      <p className="font-mono text-xs break-all text-muted-foreground">{dir}</p>
    </div>
  )
}

/**
 * The web app, the API and the bot come from one deploy: one that runs
 * another version missed it, or this page is older than the deploy.
 */
function VersionsDiffer({ page, api, bot }: { page: string; api: string; bot: string | null }) {
  const problems = [
    bot !== null &&
      bot !== api &&
      `The bot runs ${bot} and the API ${api}: one didn’t restart with the last deploy.`,
    page !== 'dev' &&
      page !== api &&
      `This page runs ${page}, older than the API’s ${api}: reload it.`,
  ].filter((problem) => problem !== false)
  if (problems.length === 0) return null
  return (
    <p className="flex items-start gap-2 rounded-xl border border-status-warning/60 bg-card px-4 py-3 text-sm">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-status-warning" aria-hidden />
      <span>{problems.join(' ')}</span>
    </p>
  )
}

function Chip({ label, detail, title }: { label: string; detail: string; title?: string }) {
  return (
    <li className="flex items-center gap-2 rounded-full border bg-card px-3 py-1.5" title={title}>
      <span className="font-medium">{label}</span>
      <span className="text-muted-foreground">{detail}</span>
    </li>
  )
}
