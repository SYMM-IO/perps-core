import type { EngineStatus, SystemStatus } from './types'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useContext, useState, useRef, type ReactNode } from 'react'

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message)
  }
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
    [error, setError] = useState('')
  const lock = useRef(false)
  const client = useQueryClient()
  async function request<T = any>(route: string, body?: unknown): Promise<T> {
    const response = await fetch(`/api/${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const result = await response.json()
    if (!response.ok) throw new ApiError(result.error || `Request failed (${response.status})`, response.status)
    return result
  }
  const engineQuery = useQuery({
    queryKey: ['engine', token],
    queryFn: () => request<EngineStatus>('status'),
    enabled: !!token,
    refetchInterval: 1500,
    retry: false,
  })
  const systemQuery = useQuery({
    queryKey: ['system', token],
    queryFn: () => request<SystemStatus>('system/status'),
    enabled: !!token,
    refetchInterval: 2000,
    retry: false,
  })
  const unauthorized = [engineQuery.error, systemQuery.error].some((e) => e instanceof ApiError && e.status === 401)
  async function refresh() {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['engine'] }),
      client.invalidateQueries({ queryKey: ['system'] }),
      client.invalidateQueries({ queryKey: ['plan'] }),
    ])
  }
  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    if (lock.current) return
    lock.current = true
    setError('')
    setOperation(label)
    try {
      return await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return undefined
    } finally {
      lock.current = false
      setOperation('')
      await refresh()
    }
  }
  async function job<T = any>(route: string, body: unknown, system = false): Promise<T> {
    await request(route, body)
    for (;;) {
      const status = await request<any>(system ? 'system/status' : 'status')
      if (!status.busy) {
        if (status.error) throw new Error(status.error)
        return status
      }
      await new Promise((resolve) => setTimeout(resolve, 700))
    }
  }
  const login = (input: string) => {
    let value = input.trim()
    try {
      value = new URL(value).hash.slice(1)
    } catch {}
    if (!/^[a-f0-9]{64}$/.test(value)) {
      setError('Paste the full local access link printed by npm run ui.')
      return
    }
    sessionStorage.setItem('workbench-token', value)
    client.removeQueries({ queryKey: ['plan'] })
    setToken(value)
    setError('')
  }
  return {
    request,
    run,
    job,
    refresh,
    engine: engineQuery.data,
    system: systemQuery.data,
    loading: engineQuery.isPending || systemQuery.isPending,
    busy: !!operation || !!engineQuery.data?.busy || !!systemQuery.data?.busy,
    operation,
    error,
    setError,
    token,
    login,
    unauthorized,
    connectionError: engineQuery.error || systemQuery.error,
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
