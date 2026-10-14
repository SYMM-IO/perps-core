import type { BodyOf, ErrorBody, ErrorCode, GetPath, Job, JobResult, JobRoute, PostRoute, ResponseOf, Time } from '../../shared/api'
import type { EngineStatus, Progress, SystemStatus } from './types'
import { hashKey, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query'
import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from 'react'

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    /** The server's short slug for the failure, e.g. `busy` or `stale-source`. */
    public code?: ErrorCode,
  ) {
    super(message)
  }
}
/** Read-only jobs the server can abort (`CANCELLABLE` in server/jobs.js). Execution, resume and task cancellation keep the task runner's own policy. */
export const CANCELLABLE = ['system/scan', 'system/compare', 'system/rehearse', 'connect', 'compile', 'rehearse']
const NEXT_STEPS: Partial<Record<ErrorCode, string>> = {
  busy: 'Wait for the current operation to finish, then try again.',
  'task-active': 'Continue or cancel the active task first. History shows which plan it is.',
  'stale-source': 'The checkout changed. Compile again.',
  'stale-plan': 'Prepare a new plan.',
  'nonce-changed': "The deployer's nonce changed. Prepare a new plan.",
  'stale-fingerprint': 'The deployment changed on chain. Inspect it again and prepare a new plan.',
  'chain-mismatch': 'Select the deployment this connection is on, or inspect the selected one again.',
}
/** The obvious next step for a failure code, when there is one. */
export const nextStep = (code?: ErrorCode) => (code ? NEXT_STEPS[code] : undefined)

/** An error as the banner shows it. `source` marks errors from server status; `held` ones the server clears on dismissal. */
export interface ShownError {
  id: string
  operation: string
  message: string
  code?: ErrorCode
  at: Time
  source?: 'engine' | 'system'
  held?: boolean
}
type Untyped<S extends string> = S extends GetPath | PostRoute ? never : unknown
export interface Request {
  <P extends GetPath>(route: P): Promise<ResponseOf<P>>
  <R extends PostRoute>(route: R, body: BodyOf<R>): Promise<ResponseOf<R>>
  /** A route the types cannot follow, built at run time. Name the result type. */
  <T, S extends string = string>(route: S & Untyped<S>, body?: unknown): Promise<T>
}
const STATUS = { engine: 'status', system: 'system/status' } as const
const POLL = { engine: 1500, system: 2000, watching: 700 }

/** Parses a response, checking the content type first so a proxy's HTML error page reads as an error, not a SyntaxError. */
export async function readResponse<T>(response: Response, route: string): Promise<T> {
  const json = (response.headers.get('content-type') || '').includes('application/json')
  const result: (T & Partial<ErrorBody>) | undefined = json ? await response.json().catch(() => undefined) : undefined
  if (!response.ok) throw new ApiError(result?.error || `Request failed (${response.status})`, response.status, result?.code)
  if (result === undefined) throw new ApiError(`The app answered /api/${route} with something other than JSON`, response.status, 'unexpected')
  return result
}
function initialToken() {
  const hash = location.hash.slice(1)
  if (/^[a-f0-9]{64}$/.test(hash)) {
    sessionStorage.setItem('workbench-token', hash)
    history.replaceState(null, '', location.pathname + location.search)
    return hash
  }
  return sessionStorage.getItem('workbench-token') || ''
}
const Context = createContext<ReturnType<typeof useWorkbenchState> | null>(null)
function useWorkbenchState() {
  const [token, setToken] = useState(initialToken),
    [operation, setOperation] = useState(''),
    [local, setLocal] = useState<ShownError | null>(null),
    [hidden, setHidden] = useState<string[]>([]),
    [watching, setWatching] = useState(0)
  const lock = useRef(false),
    tags = useRef(new Map<string, string>())
  const client = useQueryClient()
  const headers = (extra?: Record<string, string>) => ({ Authorization: `Bearer ${token}`, ...extra })

  const request = (async (route: string, body?: unknown) => {
    const response = await fetch(`/api/${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: headers(body === undefined ? undefined : { 'Content-Type': 'application/json' }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const result = await readResponse(response, route)
    // Selecting or importing a deployment can add to the address book.
    if (route === 'system/select') void client.invalidateQueries({ queryKey: ['profiles'] })
    return result
  }) as Request

  /** A status read that sends the last ETag and keeps the data it has when the server answers 304. */
  async function poll<T>(which: keyof typeof STATUS, key: QueryKey): Promise<T> {
    const previous = client.getQueryData<T>(key),
      tag = previous === undefined ? undefined : tags.current.get(which)
    const response = await fetch(`/api/${STATUS[which]}`, { headers: headers(tag ? { 'If-None-Match': tag } : undefined) })
    if (response.status === 304 && previous !== undefined) return previous
    const data = await readResponse<T>(response, STATUS[which])
    const etag = response.headers.get('etag')
    if (etag) tags.current.set(which, etag)
    else tags.current.delete(which)
    return data
  }
  const engineKey = ['engine', token],
    systemKey = ['system', token]
  const status = { enabled: !!token, retry: false, refetchIntervalInBackground: false, refetchOnWindowFocus: true } as const
  const engineQuery = useQuery({
    ...status,
    queryKey: engineKey,
    queryFn: () => poll<EngineStatus>('engine', engineKey),
    refetchInterval: watching ? POLL.watching : POLL.engine,
  })
  const systemQuery = useQuery({
    ...status,
    queryKey: systemKey,
    queryFn: () => poll<Omit<SystemStatus, 'profiles'>>('system', systemKey),
    refetchInterval: watching ? POLL.watching : POLL.system,
  })
  const profilesQuery = useQuery({
    queryKey: ['profiles', token],
    queryFn: () => request('profiles'),
    enabled: !!token,
    staleTime: Infinity,
    retry: false,
  })
  const system = useMemo<SystemStatus | undefined>(
    () => systemQuery.data && { ...systemQuery.data, profiles: profilesQuery.data?.profiles ?? [] },
    [systemQuery.data, profilesQuery.data],
  )
  const engine = engineQuery.data
  const unauthorized = [engineQuery.error, systemQuery.error, profilesQuery.error].some((e) => e instanceof ApiError && e.status === 401)

  async function refresh() {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['engine'] }),
      client.invalidateQueries({ queryKey: ['system'] }),
      client.invalidateQueries({ queryKey: ['plan'] }),
    ])
  }
  function setError(message: string, label = 'Last action') {
    setLocal(message ? { id: `local:${Date.now()}`, operation: label, message, at: Date.now() } : null)
  }
  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    if (lock.current) return
    lock.current = true
    setLocal(null)
    setOperation(label)
    try {
      return await fn()
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'cancelled'))
        setLocal({
          id: `local:${Date.now()}`,
          operation: label,
          message: e instanceof Error ? e.message : String(e),
          code: (e as ApiError).code,
          at: Date.now(),
        })
      return undefined
    } finally {
      lock.current = false
      setOperation('')
      await refresh()
    }
  }
  /** Resolves with the job once a status poll reports it finished. */
  function settled(key: QueryKey, jobId: string): Promise<Job> {
    const hash = hashKey(key)
    return new Promise((resolve, reject) => {
      let missing = 0
      const check = () => {
        const data = client.getQueryData<{ jobs?: Job[]; busy?: boolean }>(key),
          found = data?.jobs?.find((j) => j.id === jobId)
        if (found?.state && found.state !== 'running') return stop(() => resolve(found))
        // A server that has moved on without listing the job will never report it.
        if (data && !found && !data.busy && ++missing > 2) stop(() => reject(new ApiError('The app did not report this job', 500, 'unexpected')))
      }
      // A status read that keeps failing (the app stopped, or restarted with a new access link) would otherwise
      // hold the caller, and every button behind `run`, forever. The job itself is not touched.
      let failures = 0
      const unsubscribe = client.getQueryCache().subscribe((event) => {
        if (event.type !== 'updated' || event.query.queryHash !== hash) return
        if (event.action.type === 'success') {
          failures = 0
          check()
        } else if (event.action.type === 'error') {
          const error = event.action.error
          if ((error instanceof ApiError && error.status === 401) || ++failures >= 3)
            stop(() =>
              reject(
                new ApiError(
                  `Lost contact with the local app; the operation may still finish there (${error instanceof Error ? error.message : String(error)})`,
                  error instanceof ApiError ? error.status : 503,
                  'unexpected',
                ),
              ),
            )
        }
      })
      const stop = (settle: () => void) => {
        unsubscribe()
        settle()
      }
      void client.refetchQueries({ queryKey: key })
    })
  }
  /** Starts a background job and resolves with its result, read from the job itself rather than from shared status. */
  async function job<T extends JobResult = JobResult, R extends JobRoute = JobRoute>(
    route: R,
    body: BodyOf<R>,
    system = false,
  ): Promise<T | undefined> {
    const accepted = await request(route as PostRoute, body as never)
    const jobId = (accepted as { jobId?: string }).jobId
    if (!jobId) throw new ApiError(`The app started ${route} without a job id`, 500, 'unexpected')
    setWatching((n) => n + 1)
    try {
      const done = await settled(system ? systemKey : engineKey, jobId)
      if (done.state === 'done') return done.result as T | undefined
      if (done.state === 'cancelled') throw new ApiError('Cancelled', 499, 'cancelled')
      throw new ApiError(done.error || 'The operation failed', 500, done.code)
    } finally {
      setWatching((n) => n - 1)
    }
  }
  /** Asks the server to abort a read-only job. The job then ends as cancelled and the previous snapshot stays. */
  async function cancel(jobId: string) {
    try {
      await request('jobs/cancel', { jobId })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e), 'Cancel')
    }
    await refresh()
  }

  // Older servers send only the message; those are hidden locally when dismissed.
  // `held` errors carry the server's id and are cleared there; older servers send only the message.
  const serverError = (
    which: 'engine' | 'system',
    data?: { error?: string | null; errorInfo?: ShownError | null },
    at?: number,
  ): ShownError | null =>
    data?.errorInfo
      ? { ...data.errorInfo, source: which, held: true }
      : data?.error
        ? {
            id: `${which}:${data.error}`,
            operation: which === 'engine' ? 'Diamond upgrade' : 'Workspace',
            message: data.error,
            at: at || Date.now(),
            source: which,
          }
        : null
  const connectionError = engineQuery.error || systemQuery.error
  const errors = useMemo(() => {
    const all = [
      serverError('engine', engine, engineQuery.dataUpdatedAt),
      serverError('system', system, systemQuery.dataUpdatedAt),
      local,
      connectionError && !unauthorized
        ? {
            id: `connection:${connectionError.message}`,
            operation: 'Connection to the local app',
            message: connectionError.message,
            at: Math.max(engineQuery.errorUpdatedAt, systemQuery.errorUpdatedAt),
          }
        : null,
    ].filter((e): e is ShownError => !!e && !hidden.includes(e.id))
    // A failed job reaches the caller and the server alike; keep the server's copy, which it can clear.
    return all.filter((e, i) => all.findIndex((other) => other.message === e.message) === i).sort((a, b) => +new Date(b.at) - +new Date(a.at))
  }, [local, engine, system, connectionError, unauthorized, hidden])
  /** Clears the given errors (all shown ones by default), telling the server about the ones it holds. */
  async function dismiss(shown: ShownError[] = errors) {
    setHidden((h) => [...h, ...shown.map((e) => e.id)].slice(-50))
    if (local && shown.some((e) => e.id === local.id || e.message === local.message)) setLocal(null)
    await Promise.all(shown.filter((e) => e.held).map((e) => request('errors/dismiss', { id: e.id }).catch(() => {})))
    await refresh()
  }

  const jobs = useMemo(() => {
    const byId = new Map<string, Job>()
    for (const j of [...(engine?.jobs || []), ...(system?.jobs || [])]) byId.set(j.id, j)
    return [...byId.values()].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
  }, [engine?.jobs, system?.jobs])
  const progress: Progress | null = (engine?.busy && engine.progress) || (system?.busy && system.progress) || null

  const login = (input: string) => {
    let value = input.trim()
    try {
      value = new URL(value).hash.slice(1)
    } catch {}
    if (!/^[a-f0-9]{64}$/.test(value)) {
      setError('Paste the full local access link printed by npm run ui.', 'Sign in')
      return
    }
    sessionStorage.setItem('workbench-token', value)
    client.removeQueries({ queryKey: ['plan'] })
    tags.current.clear()
    setToken(value)
    setLocal(null)
  }
  return {
    request,
    run,
    job,
    cancel,
    refresh,
    engine,
    system,
    profiles: profilesQuery.data?.profiles ?? [],
    jobs,
    progress,
    loading: engineQuery.isPending || systemQuery.isPending,
    busy: !!operation || !!engine?.busy || !!system?.busy,
    operation,
    /** The message of the last local failure; the banner reads `errors`. */
    error: local?.message || '',
    errors,
    dismiss,
    setError,
    token,
    login,
    unauthorized,
    connectionError,
  }
}
export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const value = useWorkbenchState()
  return <Context.Provider value={value}>{children}</Context.Provider>
}
export function useWorkbench() {
  const value = useContext(Context)
  if (!value) throw new Error('Missing WorkbenchProvider')
  return value
}
