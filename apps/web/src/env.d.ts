interface ImportMetaEnv {
  /** The deploy's git revision, built in by docker/caddy.Dockerfile; unset in development. */
  readonly VITE_DFS_VERSION?: string
  /** When that deploy was made, as an ISO time. */
  readonly VITE_DFS_DEPLOYED_AT?: string
}
