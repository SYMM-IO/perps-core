import {
  ACTION_TYPES,
  compactNumber,
  cornerCounts,
  cornerState,
  cornerTargets,
  cornerTotals,
  coverageSnapshot,
  duration,
  elapsedMs,
  failureRecords,
  firstReached,
  firstReachedCopy,
  hasQuoteStatusBreakdown,
  hasQuoteTelemetry,
  humanize,
  inputYieldSnapshot,
  isLiveRun,
  isObject,
  isReport,
  isTerminalRun,
  numeric,
  object,
  optionalNumber,
  paceTimeline,
  participantSnapshot,
  percent,
  plural,
  queueTimeline,
  quoteStateTargets,
  quoteTimeline,
  quoteTotals,
  rate,
  reportCheckpoints,
  reportKey,
  rootCount,
  runHeadline,
  runOutcomeSnapshot,
  runSignalSnapshot,
  runStatus,
  runSummary,
  schemaNotice,
  stakeholderCopy,
  targetEvidence,
  text,
  timestampNumber,
} from './model.js'

/**
 * Renders the fuzz report into `root`, a shadow root that already holds dashboard.html.
 * Returns `dispose` to stop polling and `redraw` to repaint the charts after a theme change.
 */
export function mountFuzzDashboard(root, { authorization }) {
  const lifetime = new AbortController()
  let disposed = false
  let resizeObserver = null
  let runsLoading = false

  // The runner writes the report at most every two seconds.
  const POLL_INTERVAL_MS = 2_000
  const RUNS_INTERVAL_MS = 12_000
  const FETCH_TIMEOUT_MS = 5_000
  const STALE_AFTER_MS = 5_000
  const COPIED_MS = 2_000
  const ACTIVITY_PAGE_SIZE = 12
  const UNCHANGED = Symbol('unchanged')
  const clockFormatter = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const shortDateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const quotePlural = new Intl.PluralRules()
  const outcomeList = new Intl.ListFormat(undefined, { type: 'conjunction' })
  const reportedNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 20 })

  const dom = {}
  const chartCursors = new WeakMap()
  const copyTimers = new Map()
  const runWarning = create('p', 'run-warning')
  const state = {
    report: null,
    reportKey: '',
    etag: null,
    runs: [],
    selectedRunId: '',
    following: true,
    lastSuccessAt: 0,
    lastReportAt: 0,
    error: null,
    reportRequest: 0,
    reportPending: true,
    retrying: false,
    coverage: null,
    pollTimer: null,
    statusTimer: null,
    runsTimer: null,
    resizeFrame: 0,
    chartWindow: 64,
    activityFilter: 'all',
    activityVisible: ACTIVITY_PAGE_SIZE,
    detailsTab: 'coverage',
    problemRun: '',
    problemSignature: '',
    problemTraces: new Map(),
    connectionState: '',
    storyAnimation: null,
    storyFrame: 0,
  }

  function element(id) {
    return root.getElementById(id)
  }

  function cacheDom() {
    for (const id of [
      'connection-banner',
      'connection-label',
      'connection-detail',
      'run-select',
      'archive-feedback',
      'archive-message',
      'archive-retry',
      'follow-button',
      'follow-button-label',
      'export-report',
      'export-hint',
      'waiting-state',
      'waiting-title',
      'start-guidance',
      'copy-start-command',
      'start-command',
      'error-banner',
      'error-message',
      'retry-button',
      'dashboard',
      'schema-notice',
      'run-status',
      'run-mode',
      'run-title',
      'run-subtitle',
      'problems',
      'problems-count',
      'problems-list',
      'problems-seed',
      'problems-copy',
      'problems-replay-note',
      'problems-earlier',
      'problems-earlier-label',
      'problems-earlier-list',
      'seed-value',
      'trace-value',
      'technical-mode-value',
      'technical-cycle-value',
      'story',
      'story-replay',
      'story-track',
      'story-token',
      'story-actors',
      'story-stage-copy',
      'health-note',
      'kpi-strip',
      'quotes-title',
      'outcome-bar',
      'outcome-strip',
      'outcome-note',
      'quote-breakdown-label',
      'coverage-verdict-title',
      'coverage-status',
      'coverage-summary',
      'coverage-grid',
      'coverage-gaps',
      'chart-window-summary',
      'details-scroll-reserve',
      'confidence-limit-summary',
      'confidence-limit-list',
      'quote-chart',
      'quote-tooltip',
      'quote-chart-table',
      'pace-chart',
      'pace-tooltip',
      'pace-chart-table',
      'pace-telemetry-note',
      'queue-chart',
      'queue-tooltip',
      'queue-chart-table',
      'queue-telemetry-note',
      'lifecycle-summary',
      'lifecycle-bars',
      'action-type-summary',
      'action-type-coverage',
      'corner-matrix',
      'mix-grid',
      'activity-list',
      'activity-count',
      'activity-retention-note',
      'activity-footer',
      'activity-more',
      'replay-command',
      'copy-replay-panel',
      'retention-list',
      'announcer',
    ]) {
      dom[id] = element(id)
    }
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value))
  }

  function bytes(value) {
    const size = optionalNumber(value)
    if (size === undefined) return '—'
    if (size < 1_024) return `${Math.round(size)} B`
    if (size < 1_048_576) return `${(size / 1_024).toFixed(1)} KiB`
    return `${(size / 1_048_576).toFixed(1)} MiB`
  }

  function clockTime(value) {
    const timestamp = timestampNumber(value)
    if (timestamp === undefined) return ''
    return clockFormatter.format(timestamp)
  }

  function shortDate(value) {
    const timestamp = timestampNumber(value)
    if (timestamp === undefined) return ''
    return shortDateFormatter.format(timestamp)
  }

  function ago(timestamp) {
    if (!timestamp) return 'waiting'
    const elapsed = Math.max(0, Date.now() - timestamp)
    if (elapsed < 1_500) return 'just now'
    if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)}s ago`
    if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`
    return shortDate(timestamp)
  }

  function create(tag, className, content) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (content !== undefined) node.textContent = text(content, '')
    return node
  }

  // Writing the same text again would still replace the text node and drop any selection in it.
  function setText(node, value, fallback = '—') {
    const next = text(value, fallback)
    if (node && node.textContent !== next) node.textContent = next
  }

  function announce(message) {
    if (!dom.announcer) return
    dom.announcer.textContent = ''
    window.setTimeout(() => {
      dom.announcer.textContent = message
    }, 20)
  }

  /** The live view runs its clock to now; anything else stops at the last report write. */
  function viewNow(report) {
    const fresh =
      state.report === report &&
      state.following &&
      !state.selectedRunId &&
      isLiveRun(report) &&
      state.lastReportAt > 0 &&
      Date.now() - state.lastReportAt <= STALE_AFTER_MS
    return fresh ? Date.now() : undefined
  }

  function seedOf(report) {
    return text(report?.run?.seed ?? report?.run?.config?.seed, '')
  }

  function replayCommand(report) {
    return text(report?.run?.replay, '')
  }

  function humanRunMode(mode) {
    if (mode === 'continuous') return 'Continuous simulation'
    if (mode === 'bounded') return 'Bounded replay'
    return mode ? humanize(mode) : 'Mode unavailable'
  }

  // ---- Copy ---------------------------------------------------------------------------------------

  async function writeClipboard(value) {
    try {
      await navigator.clipboard.writeText(value)
      return true
    } catch {
      const input = document.createElement('textarea')
      input.value = value
      input.setAttribute('readonly', '')
      input.style.position = 'fixed'
      input.style.left = '-10000px'
      document.body.append(input)
      input.select()
      const copied = typeof document.execCommand === 'function' && document.execCommand('copy')
      input.remove()
      return copied
    }
  }

  /** Copies `value` and says so on the button itself for two seconds, as the app's copy buttons do. */
  async function copyWithFeedback(value, button, what) {
    if (!value) return
    const copied = await writeClipboard(value)
    if (disposed) return
    if (button) {
      button.dataset.label ??= button.textContent
      button.textContent = copied ? 'Copied' : 'Copy failed'
      button.dataset.copied = copied ? 'true' : 'false'
      window.clearTimeout(copyTimers.get(button))
      copyTimers.set(
        button,
        window.setTimeout(() => {
          button.textContent = button.dataset.label
          delete button.dataset.copied
        }, COPIED_MS),
      )
    }
    announce(copied ? `${what} copied.` : `${what} could not be copied.`)
  }

  // ---- Header, problems and KPIs ------------------------------------------------------------------

  function renderRunStatus(report, connectionState = state.connectionState) {
    const outcome = runOutcomeSnapshot(report)
    const snapshot = connectionState === 'stale' || connectionState === 'frozen' || connectionState === 'error'
    setText(dom['run-status'], `${snapshot ? 'Last reported: ' : ''}${outcome.label}`)
    dom['run-status'].dataset.tone = snapshot && outcome.tone !== 'bad' ? 'warn' : outcome.tone
  }

  function renderRunMetadata(report) {
    const blockedProbability = optionalNumber(report?.run?.config?.blockedQuoteProbability)
    const parts = [runSummary(report, viewNow(report)), 'Configured targets only']
    if (blockedProbability !== undefined) {
      parts.push(blockedProbability === 0 ? 'blocked generation off' : `blocked generation ${percent(blockedProbability)}`)
    }
    setText(dom['run-subtitle'], parts.join(' · '))
  }

  function renderRunHeader(report, coverage) {
    const mode = report?.run?.config?.runMode
    const trace = text(report?.run?.traceHash, '')
    renderRunStatus(report)
    setText(dom['run-mode'], humanRunMode(mode))
    setText(dom['run-title'], runHeadline(report, state.connectionState))
    if (runStatus(report) !== 'failed' && coverage.tone === 'warn') {
      setText(runWarning, coverage.summary)
      if (!runWarning.parentNode) dom['run-subtitle'].before(runWarning)
    } else {
      runWarning.remove()
    }
    renderRunMetadata(report)
    setText(dom['seed-value'], seedOf(report))
    dom['seed-value'].title = seedOf(report)
    setText(dom['trace-value'], trace ? trace.slice(0, 16) : '—')
    dom['trace-value'].title = trace
    setText(dom['technical-mode-value'], humanRunMode(mode))
    setText(dom['technical-cycle-value'], compactNumber(rootCount(report)))
    const notice = schemaNotice(report)
    setText(dom['schema-notice'], notice, '')
    dom['schema-notice'].hidden = !notice
  }

  function failureItem(failure, latest) {
    const node = create('li', 'problem')
    const where = [
      failure.cycle !== undefined && `cycle ${compactNumber(failure.cycle)}`,
      failure.actionSequence !== undefined && `action #${failure.actionSequence}`,
      failure.actionTitle,
    ].filter(Boolean)
    node.append(create('p', 'problem__boundary', humanize(failure.boundary)), create('p', 'problem__message', failure.message))
    if (where.length || latest) {
      const context = create('div', 'problem__context')
      if (where.length) context.append(create('p', 'problem__where', `During ${where.join(' · ')}`))
      if (latest) context.append(create('p', 'problem__where', 'Latest'))
      node.append(context)
    }
    if (failure.stack || failure.cause) {
      const disclosure = create('details', 'problem__trace')
      disclosure.append(create('summary', '', failure.cause ? 'Stack and cause' : 'Stack'))
      if (failure.stack) disclosure.append(create('pre', '', failure.stack))
      if (failure.cause) disclosure.append(create('p', 'problem__trace-label', 'Cause'), create('pre', '', failure.cause))
      node.append(disclosure)
    }
    return node
  }

  /** What failed, where, and how to replay it, directly under the hero. Hidden on a clean run. */
  function renderProblems(report) {
    const signals = runSignalSnapshot(report)
    const failures = failureRecords(report)
    const run = JSON.stringify([report?.run?.startedAt, seedOf(report)])
    if (state.problemRun !== run) {
      state.problemRun = run
      state.problemSignature = ''
      state.problemTraces.clear()
      dom['problems-earlier'].open = false
    }
    const show = signals.hasFailure || Boolean(signals.storageWarning)
    dom.problems.hidden = !show
    dom.problems.dataset.tone = signals.hasFailure ? 'bad' : 'warn'
    setText(
      dom['problems-count'],
      failures.length
        ? plural(failures.length, 'failure')
        : signals.hasFailure
          ? plural(signals.failureCategories.length, 'signal')
          : 'Storage warning',
    )
    const terminal = isTerminalRun(report)
    const signature = JSON.stringify([failures, signals.failureCategories, signals.storageWarning, terminal])
    if (state.problemSignature !== signature) {
      state.problemSignature = signature
      const traces = new Map()
      const newestFirst = failures
        .map((failure, index) => {
          const item = failureItem(failure, index === failures.length - 1)
          const trace = item.querySelector('details')
          if (trace) {
            const key = JSON.stringify(failure)
            const copies = traces.get(key) ?? []
            trace.open = state.problemTraces.get(key)?.[copies.length]?.open ?? false
            copies.push(trace)
            traces.set(key, copies)
          }
          return item
        })
        .reverse()
      state.problemTraces = traces
      const [latest, ...earlier] = newestFirst
      const preview = latest ? [latest] : []
      if (!latest && signals.hasFailure) {
        const node = create('li', 'problem')
        node.append(
          create('p', 'problem__boundary', 'Run signals'),
          create('p', 'problem__message', signals.failureCategories.join(' · ')),
          create('p', 'problem__where', terminal ? 'The report kept no failure detail.' : 'Failure detail arrives when the run ends.'),
        )
        preview.push(node)
      }
      if (signals.storageWarning) {
        const node = create('li', 'problem')
        node.dataset.tone = 'warn'
        node.append(create('p', 'problem__boundary', 'Report storage'), create('p', 'problem__message', signals.storageWarning))
        preview.push(node)
      }
      dom['problems-list'].replaceChildren(...preview)
      dom['problems-earlier-list'].replaceChildren(...earlier)
      dom['problems-earlier'].hidden = earlier.length === 0
      setText(dom['problems-earlier-label'], plural(earlier.length, 'earlier failure'))
    }
    const replay = replayCommand(report)
    setText(dom['problems-seed'], seedOf(report))
    dom['problems-copy'].disabled = !replay
    setText(dom['problems-replay-note'], replay ? '' : 'The replay command is written when the run ends.', '')
    dom['problems-replay-note'].hidden = Boolean(replay)
  }

  function inputYieldValue(snapshot) {
    if (snapshot?.ratio === undefined) return '—'
    if (snapshot.sent > 0 && snapshot.ratio < 0.0005) return '<0.1%'
    if (snapshot.discarded > 0 && snapshot.ratio >= 0.995) return '>99%'
    return percent(snapshot.ratio)
  }

  function renderKpis(report) {
    const { states, actions } = targetEvidence(report)
    const corners = cornerTotals(report)
    const cornerTargetList = cornerTargets(report)
    const cornersAvailable = Object.keys(object(report?.latest?.corners?.byOperation)).length > 0
    const cornerTypes = cornerTargetList.filter((target) => cornerCounts(report?.latest?.corners, target.key).succeeded > 0).length
    const signals = runSignalSnapshot(report)
    const yieldSnapshot = inputYieldSnapshot(report)
    const reachedStates = states.targets.length - states.missing.length
    const checkedActions = actions.targets.length - actions.missing.length
    const kpis = [
      {
        label: 'Failures or timeouts',
        value: signals.hasFailure ? 'FOUND' : signals.evidenceComplete ? '0' : '—',
        detail: signals.hasFailure
          ? signals.failureCategories.slice(0, 2).join(' · ')
          : signals.evidenceComplete
            ? 'No test failures detected'
            : `Unavailable: ${signals.evidenceGaps.join(', ')}`,
        tone: signals.hasFailure ? 'bad' : signals.evidenceComplete ? 'good' : 'warn',
      },
      {
        label: 'Input yield',
        value: inputYieldValue(yieldSnapshot),
        detail: !yieldSnapshot
          ? 'Input counts unavailable'
          : yieldSnapshot.total === 0
            ? 'No inputs generated yet'
            : `${compactNumber(yieldSnapshot.sent)} sent · ${compactNumber(yieldSnapshot.discarded)} discarded${
                yieldSnapshot.reasons.length
                  ? ` · mostly ${yieldSnapshot.reasons.map((entry) => `${entry.reason} (${compactNumber(entry.count)})`).join(', ')}`
                  : ''
              }`,
        tone: yieldSnapshot?.ratio === undefined ? 'neutral' : yieldSnapshot.ratio < 0.5 ? 'warn' : 'neutral',
      },
      {
        label: 'Quote states reached',
        value: states.available ? `${reachedStates}/${states.targets.length}` : '—',
        detail: states.available
          ? states.missing.length === 0
            ? 'All configured quote states'
            : `${states.missing.length} configured states not reached`
          : 'Quote-state evidence unavailable',
        tone: states.available && states.missing.length === 0 ? 'good' : 'warn',
      },
      {
        label: 'Action types checked',
        value: actions.available ? `${checkedActions}/${actions.targets.length}` : '—',
        detail: !actions.available
          ? 'State-check evidence unavailable'
          : actions.missing.length === 0
            ? 'Each supported type checked at least once'
            : `${checkedActions} of ${actions.targets.length} checked · ${actions.missing.length} missing`,
        tone: actions.available && actions.missing.length === 0 ? 'good' : 'warn',
      },
      {
        label: 'High-risk attempts passed',
        value: cornersAvailable ? `${compactNumber(corners.succeeded)}/${compactNumber(corners.attempted)}` : '—',
        detail: cornersAvailable ? `${cornerTypes}/${cornerTargetList.length} distinct workflow types passed` : 'Workflow evidence unavailable',
        tone: cornersAvailable && corners.failed === 0 && cornerTypes === cornerTargetList.length ? 'good' : 'warn',
      },
    ]
    dom['kpi-strip'].replaceChildren(
      ...kpis.map((kpi) => {
        const node = create('article', 'kpi')
        node.dataset.tone = kpi.tone
        node.append(create('p', 'kpi__label', kpi.label), create('p', 'kpi__value', kpi.value), create('p', 'kpi__detail', kpi.detail))
        return node
      }),
    )
  }

  // ---- Coverage -----------------------------------------------------------------------------------

  function renderCoverageMessage(coverage, connectionState) {
    const snapshot = coverage.label === 'BUILDING' && ['stale', 'frozen', 'error'].includes(connectionState)
    setText(dom['coverage-verdict-title'], snapshot ? 'Coverage at last report' : coverage.title)
    setText(dom['coverage-status'], snapshot ? 'LAST REPORT' : coverage.label)
    dom['coverage-status'].dataset.tone = coverage.tone
    setText(dom['coverage-summary'], snapshot ? coverage.snapshotSummary : coverage.summary)
    dom['coverage-summary'].hidden = coverage.label === 'GAPS'
  }

  function renderCoverageVerdict(coverage) {
    const container = dom['coverage-status'].closest('.coverage-verdict')
    if (container) container.dataset.tone = coverage.tone
    dom['coverage-grid'].replaceChildren(
      ...coverage.cards.map((card) => {
        const node = create('article', 'coverage-card')
        node.dataset.tone = card.tone
        const header = create('div', 'coverage-card__header')
        header.append(create('p', 'coverage-card__label', card.label), create('p', 'coverage-card__value', card.value))
        node.append(header, create('p', 'coverage-card__detail', card.detail))
        return node
      }),
    )
    const groups = coverage.gapGroups.map(({ id, title, targets }) => {
      const section = create('section', 'coverage-gap-group')
      section.dataset.group = id
      const heading = create('h3', '', title)
      heading.id = `coverage-gap-${id}`
      const list = create('ul', '')
      list.setAttribute('role', 'list')
      list.setAttribute('aria-labelledby', heading.id)
      for (const target of targets) {
        const item = create('li', 'coverage-gap', target)
        item.dataset.tone = 'warn'
        list.append(item)
      }
      section.append(heading, list)
      return section
    })
    if (coverage.notices.length) {
      const notices = create('ul', 'coverage-notices')
      notices.setAttribute('role', 'list')
      notices.setAttribute('aria-label', 'Coverage warnings and notes')
      for (const notice of coverage.notices) {
        const item = create('li', 'coverage-gap', notice.label)
        item.dataset.tone = notice.tone
        notices.append(item)
      }
      groups.push(notices)
    }
    dom['coverage-gaps'].replaceChildren(...groups)
    dom['coverage-gaps'].hidden = groups.length === 0
  }

  function renderConfidenceLimits(report) {
    const config = object(report?.run?.config)
    const assurance = object(report?.latest?.assurance)
    const target = optionalNumber(config.validationProbability)
    const eligible = optionalNumber(assurance.observableSuccessfulTransitions)
    const checked = optionalNumber(assurance.confirmedValidatorTransitions)
    setText(
      dom['confidence-limit-summary'],
      eligible !== undefined && checked !== undefined
        ? `Independent validators checked ${compactNumber(checked)} of ${compactNumber(eligible)} eligible observable state changes (${percent(
            eligible ? checked / eligible : undefined,
          )})${target !== undefined ? ` against a ${percent(target)} target` : ''}.`
        : 'Validator sampling detail is unavailable in this report.',
    )
    const blockedProbability = optionalNumber(config.blockedQuoteProbability)
    const droppedActivity = numeric(report?.retention?.droppedActivity)
    const limits = [
      blockedProbability === 0
        ? 'Blocked-quote generation was disabled (0%), so blocked-input behavior was not sampled by ordinary generation.'
        : blockedProbability !== undefined
          ? `Blocked-quote generation was configured at ${percent(blockedProbability)}.`
          : 'Blocked-quote generation configuration is unavailable.',
      'All configured run targets may be reached without covering every contract path, parameter combination, or economic condition.',
      'Quote-state and action-type evidence is aggregated across many quotes; it does not describe one end-to-end user journey.',
      'Historical close-order-mode coverage is not recorded; closing-mode counts describe only live close requests.',
    ]
    if (droppedActivity > 0) {
      limits.push(`${compactNumber(droppedActivity)} older raw activity events were not retained; summary counters remain authoritative.`)
    }
    dom['confidence-limit-list'].replaceChildren(...limits.map((limit) => create('li', '', limit)))
  }

  function renderLifecycle(report) {
    const quotes = object(report?.latest?.quotes)
    const breakdownAvailable = hasQuoteStatusBreakdown(quotes)
    const counts = object(quotes.byStatus)
    const { states } = targetEvidence(report)
    setText(
      dom['lifecycle-summary'],
      states.available
        ? `${compactNumber(states.targets.length - states.missing.length)} / ${states.targets.length} observed`
        : 'Coverage unavailable',
    )
    setText(dom['quote-breakdown-label'], `All ${states.targets.length} states & modes`)
    const groups = [
      { key: 'waiting', label: 'Waiting to open' },
      { key: 'positions', label: 'Open positions' },
      { key: 'outcomes', label: 'Ended outcomes' },
      { key: 'other', label: 'Other states' },
    ]
    const groupNodes = groups.flatMap((group) => {
      const members = states.targets.filter((target) => target.group === group.key)
      if (members.length === 0) return []
      const node = create('section', 'lifecycle-group')
      node.append(create('h3', 'lifecycle-group__title', group.label))
      for (const item of members) {
        const row = create('div', 'lifecycle-row')
        const currentValue = optionalNumber(counts[item.key])
        const currentAvailable = breakdownAvailable && currentValue !== undefined
        const observed = states.available ? states.observed.has(item.key) : undefined
        const first = firstReachedCopy(firstReached(report, 'quoteStates', item.key))
        row.dataset.group = group.key
        row.dataset.status = item.key
        row.dataset.current = currentAvailable ? 'available' : 'unknown'
        row.dataset.observed = observed === undefined ? 'unknown' : observed ? 'true' : 'false'
        row.setAttribute(
          'aria-label',
          `${item.label}: current count ${currentAvailable ? compactNumber(currentValue) : 'unavailable'}; ${
            observed === undefined ? 'historical target evidence unavailable' : observed ? 'observed during this run' : 'not observed during this run'
          }${first ? `, ${first}` : ''}`,
        )
        const label = create('span', 'lifecycle-row__label')
        label.append(create('span', '', item.label))
        if (first) label.append(create('span', 'lifecycle-row__first', first))
        row.append(
          label,
          create('span', 'lifecycle-row__value', currentAvailable ? compactNumber(currentValue) : '—'),
          create('span', 'lifecycle-row__history', observed === undefined ? 'unavailable' : observed ? 'yes' : 'no'),
        )
        node.append(row)
      }
      return [node]
    })
    dom['lifecycle-bars'].replaceChildren(...groupNodes)
  }

  function renderActionTypes(report) {
    const { actions } = targetEvidence(report)
    setText(
      dom['action-type-summary'],
      actions.available ? `${actions.targets.length - actions.missing.length} / ${actions.targets.length} types checked` : 'Evidence unavailable',
    )
    dom['action-type-coverage'].replaceChildren(
      ...ACTION_TYPES.map((action) => {
        const isConfirmed = actions.confirmed.has(action)
        const chip = create('span', 'action-type-chip', `${!actions.available ? '—' : isConfirmed ? '✓' : '○'} ${humanize(action)}`)
        chip.dataset.state = !actions.available ? 'unknown' : isConfirmed ? 'confirmed' : 'missing'
        const meaning = !actions.available
          ? 'confirmed action-type data unavailable'
          : isConfirmed
            ? 'at least one observable state change was independently checked'
            : 'no independently checked state change observed yet'
        chip.title = meaning
        chip.setAttribute('aria-label', `${humanize(action)}: ${meaning}`)
        return chip
      }),
    )
  }

  const CORNER_GLYPHS = { passed: '✓', 'verified-with-failures': '!', failed: '×', unresolved: '?', skipped: '↷', unknown: '?' }

  function renderCorners(report) {
    const corners = report?.latest?.corners
    const coverageAvailable = Object.keys(object(object(corners).byOperation)).length > 0
    const rows = cornerTargets(report).map((operation) => {
      const counts = cornerCounts(corners, operation.key)
      const operationState = coverageAvailable ? cornerState(counts) : 'unknown'
      const milestone = firstReached(report, 'corners', operation.key)
      const row = create('div', 'corner-row')
      row.dataset.state = operationState
      const identity = create('div')
      identity.append(
        create('p', 'corner-row__name', operation.label),
        create(
          'p',
          'corner-row__detail',
          operationState === 'unknown'
            ? 'Coverage data unavailable'
            : operationState === 'verified-with-failures'
              ? 'Both passes and failures recorded'
              : operationState === 'unresolved'
                ? `${plural(counts.unresolved, 'attempt')} with no recorded outcome`
                : humanize(operationState),
        ),
      )
      if (milestone) {
        const first = [firstReachedCopy(milestone), stakeholderCopy(milestone.detail)].filter(Boolean).join(' · ')
        identity.append(create('p', 'corner-row__first', first))
      }
      const unresolvedCount = counts.unresolved > 0 ? `\n${compactNumber(counts.unresolved)} unresolved` : ''
      row.append(
        create('span', 'corner-row__glyph', CORNER_GLYPHS[operationState] ?? '·'),
        identity,
        create('p', 'corner-row__counts', `${compactNumber(counts.succeeded)} pass\n${compactNumber(counts.failed)} fail${unresolvedCount}`),
      )
      return row
    })
    dom['corner-matrix'].replaceChildren(...rows)
  }

  // ---- Quote outcomes and mix ---------------------------------------------------------------------

  function renderOutcomes(report) {
    const quotes = report?.latest?.quotes
    if (!hasQuoteTelemetry(quotes)) {
      dom['outcome-bar'].replaceChildren()
      dom['outcome-bar'].setAttribute('aria-label', 'Quote outcome distribution unavailable')
      setText(dom['quotes-title'], 'Quote outcomes')
      dom['outcome-strip'].replaceChildren(create('p', 'empty-copy', 'Quote outcomes are unavailable in this report.'))
      setText(dom['outcome-note'], 'The report does not contain a current quote-state snapshot.')
      return
    }
    const totals = quoteTotals(quotes)
    const oneQuote = totals.total !== undefined && quotePlural.select(totals.total) === 'one'
    const count = compactNumber(totals.total)
    if (!hasQuoteStatusBreakdown(quotes)) {
      dom['outcome-bar'].replaceChildren()
      dom['outcome-bar'].setAttribute('aria-label', 'Quote outcome distribution unavailable')
      dom['outcome-strip'].replaceChildren(
        create(
          'p',
          'empty-copy',
          totals.total === undefined
            ? 'A per-state quote outcome breakdown is unavailable.'
            : oneQuote
              ? `${count} quote was reported, but the per-state outcome breakdown is unavailable.`
              : `${count} quotes were reported, but the per-state outcome breakdown is unavailable.`,
        ),
      )
      setText(dom['outcome-note'], 'Unknown outcome fields are not treated as zero.')
      return
    }
    const counts = object(quotes.byStatus)
    const valueFor = (key) => optionalNumber(counts[key])
    const warnIfAny = (key) => (numeric(valueFor(key)) > 0 ? 'warn' : 'neutral')
    const outcomes = [
      { label: 'Closed', value: valueFor('CLOSED'), tone: 'good' },
      { label: 'Canceled', value: valueFor('CANCELED'), tone: 'neutral' },
      { label: 'Still active', value: totals.active, tone: 'info' },
      { label: 'Liquidated', value: valueFor('LIQUIDATED'), tone: warnIfAny('LIQUIDATED'), pattern: 'solid' },
      { label: 'Expired', value: valueFor('EXPIRED'), tone: warnIfAny('EXPIRED'), pattern: 'diagonal' },
      { label: 'Liquidated before opening', value: valueFor('LIQUIDATED_PENDING'), tone: warnIfAny('LIQUIDATED_PENDING'), pattern: 'dots' },
    ]
    const reportedTotal = optionalNumber(quotes.total)
    const classified = outcomes.reduce((sum, outcome) => sum + (outcome.value ?? 0), 0)
    const reconciles = Number.isInteger(reportedTotal) && classified <= reportedTotal &&
      outcomes.every(({ value }) => value === undefined || (Number.isInteger(value) && value >= 0))
    const remainder = reconciles ? reportedTotal - classified : 0
    if (remainder > 0) outcomes.push({ label: 'Unclassified', value: remainder, tone: 'unclassified' })
    const positive = outcomes.filter((outcome) => outcome.value > 0)
    const reportedZeros = outcomes.filter((outcome) => outcome.value === 0)
    const missing = outcomes.filter((outcome) => outcome.value === undefined)
    dom['outcome-bar'].replaceChildren(
      ...(reconciles ? positive : []).map((outcome) => {
        const segment = create('span', 'outcome-bar__segment')
        segment.dataset.tone = outcome.tone
        if (outcome.pattern) segment.dataset.pattern = outcome.pattern
        segment.style.flexBasis = `${(outcome.value / reportedTotal) * 100}%`
        segment.title = `${outcome.label}: ${outcome.value.toLocaleString('en-US')}`
        return segment
      }),
    )
    dom['outcome-bar'].setAttribute(
      'aria-label',
      reconciles
        ? positive.map((outcome) => `${outcome.label} ${outcome.value.toLocaleString('en-US')}`).join(', ') || 'No quotes reported'
        : 'Quote outcome distribution unavailable',
    )
    const legend = create('ul', 'outcome-legend')
    legend.setAttribute('role', 'list')
    legend.append(
      ...positive.map((outcome) => {
        const item = create('li', 'outcome-legend__entry')
        const swatch = create('span', 'outcome-legend__swatch')
        swatch.dataset.tone = outcome.tone
        if (outcome.pattern) swatch.dataset.pattern = outcome.pattern
        swatch.setAttribute('aria-hidden', 'true')
        item.append(
          swatch,
          create('span', 'outcome-legend__label', outcome.label),
          ' ',
          create('span', 'outcome-legend__value', outcome.value.toLocaleString('en-US')),
        )
        return item
      }),
      ...reportedZeros.map((outcome) => create('li', 'outcome-legend__zero', `${outcome.label} 0`)),
    )
    const summary = []
    if (legend.childElementCount) summary.push(legend)
    if (!reconciles) {
      summary.push(create('p', 'outcome-legend__missing', reportedTotal === undefined
        ? 'Quote outcome proportions are unavailable because the report does not give a total.'
        : 'Quote outcome proportions are unavailable because the counts do not reconcile with the reported total.'))
    }
    if (missing.length) {
      summary.push(create('p', 'outcome-legend__missing', `No count reported for ${outcomeList.format(missing.map((outcome) => outcome.label))}.`))
    }
    dom['outcome-strip'].replaceChildren(...summary)
  }

  function renderOutcomeFreshness(report, connectionState) {
    const quotes = report.latest?.quotes
    if (!hasQuoteTelemetry(quotes)) return
    const { active, total } = quoteTotals(quotes)
    const retained = ['stale', 'frozen', 'error'].includes(connectionState)
    const live = isLiveRun(report)
    const count = compactNumber(total)
    const quoteLabel = quotePlural.select(total) === 'one' ? 'quote' : 'quotes'
    const title = total === undefined ? 'Quote outcomes' : `Where ${count} ${quoteLabel} ended up`
    setText(dom['quotes-title'], live && retained ? 'Quote outcomes at last report' : title)
    if (!hasQuoteStatusBreakdown(quotes)) return
    if (active === undefined) {
      setText(dom['outcome-note'], 'The active-quote count is unavailable; unknown fields are not treated as zero.')
      return
    }
    setText(
      dom['outcome-note'],
      retained
        ? `${compactNumber(active)} active in the last reported snapshot`
        : live
          ? `${compactNumber(active)} active now`
          : report.run?.config?.runMode === 'continuous'
            ? `${compactNumber(active)} still active at stop · not failures`
            : `${compactNumber(active)} still active in the final snapshot`,
    )
  }

  function mixBlock(label, value, detail, ratioValue, ratioLabel) {
    const node = create('div', 'mix-block')
    node.append(create('p', 'mix-block__label', label), create('p', 'mix-block__value', value), create('p', 'mix-block__detail', detail))
    if (ratioValue !== undefined) {
      const meter = create('div', 'mix-meter')
      const fill = create('div', 'mix-meter__fill')
      if (ratioLabel) {
        meter.setAttribute('role', 'meter')
        meter.setAttribute('aria-label', ratioLabel)
        meter.setAttribute('aria-valuemin', '0')
        meter.setAttribute('aria-valuemax', '100')
        meter.setAttribute('aria-valuenow', String(ratioValue * 100))
        meter.setAttribute('aria-valuetext', percent(ratioValue))
      } else meter.setAttribute('aria-hidden', 'true')
      fill.style.width = `${clamp(ratioValue * 100, 0, 100)}%`
      meter.append(fill)
      node.append(meter)
    }
    return node
  }

  function renderMix(report) {
    const quotes = report?.latest?.quotes
    const validation = percent(report?.run?.config?.validationProbability)
    if (!hasQuoteTelemetry(quotes)) {
      dom['mix-grid'].replaceChildren(
        mixBlock('Quote execution mix', '—', 'Current quote inventory unavailable'),
        mixBlock('State-check target', validation, 'Ordinary transition sampling'),
      )
      return
    }
    const position = object(quotes.byPositionType)
    const opening = object(quotes.byOpeningOrderType)
    const closing = object(quotes.byCloseOrderType)
    const partialOpen = object(quotes.partialOpen)
    const long = optionalNumber(position.LONG)
    const short = optionalNumber(position.SHORT)
    const known = (value) => (value === undefined ? '—' : compactNumber(value))
    const pair = (left, right) => (left === undefined || right === undefined ? '—' : `${compactNumber(left)} / ${compactNumber(right)}`)
    const modes = (source) => {
      const fields = [['Limit', 'LIMIT'], ['Market', 'MARKET'], ['Best effort', 'MARKET_BEST_EFFORT']]
      const counts = fields.map(([, key]) => optionalNumber(source[key]))
      const total = counts.every((count) => count !== undefined) ? counts.reduce((sum, count) => sum + count, 0) : undefined
      return {
        value: fields.map(([label], index) => {
          const count = counts[index]
          const share = total > 0 ? ` (${percent(count / total)})` : ''
          return `${label} ${formatReported(count)}${share}`
        }).join(' · '),
        ratio: total > 0 ? counts[0] / total : undefined,
      }
    }
    const openModes = modes(opening)
    const closeModes = modes(closing)
    const activeSplit = optionalNumber(partialOpen.activePositions)
    dom['mix-grid'].replaceChildren(
      mixBlock(
        'Long / short',
        pair(long, short),
        'All observed quotes',
        long === undefined || short === undefined ? undefined : long + short === 0 ? 0 : long / (long + short),
      ),
      mixBlock('Opening order modes', openModes.value, 'First-seen order mode', openModes.ratio, 'Limit share of opening order modes'),
      mixBlock('Closing order modes', closeModes.value, 'Live close requests only', closeModes.ratio, 'Limit share of closing order modes'),
      mixBlock(
        'Split opens',
        known(optionalNumber(partialOpen.splits)),
        activeSplit === undefined ? 'Active split-position count unavailable' : `${compactNumber(activeSplit)} active split positions`,
      ),
      mixBlock('Waiting remainders', known(optionalNumber(partialOpen.waitingRemainders)), 'Pre-open split children'),
      mixBlock('Partial close requests', known(optionalNumber(quotes.partialCloseRequested)), 'Request < remaining open amount'),
      mixBlock('Partially closed', known(optionalNumber(quotes.partiallyClosed)), '0 < closed amount < quantity'),
      mixBlock('State-check target', validation, 'Ordinary transition sampling'),
    )
  }

  // ---- Charts -------------------------------------------------------------------------------------

  function formatReported(value) {
    return value === undefined ? '—' : reportedNumber.format(value)
  }

  function hasMeasurements(point, fields) {
    return fields.some((field) => point[field] !== undefined)
  }

  const QUOTE_FIELDS = ['live', 'ended']
  const PACE_FIELDS = ['rate', 'p50', 'p95']
  const QUEUE_COUNT_FIELDS = ['outstanding', 'pending', 'scheduled']
  const QUEUE_FIELDS = [...QUEUE_COUNT_FIELDS, 'running']
  const SERIES_PATTERNS = { '--proof': [], '--series-secondary': [8, 4], '--series-neutral': [1, 4] }

  function timelineWindowCaption(label, visible, total) {
    if (visible >= total) return `${label} across all ${compactNumber(total)} retained checkpoints`
    return `${label}; latest ${compactNumber(visible)} of ${compactNumber(total)} retained checkpoints`
  }

  function paceTelemetryCopy(points) {
    const exact = points.some((point) => point.exact)
    const approximate = points.some((point) => point.approximate)
    if (exact && approximate) return 'Mixed duration data: reported rolling windows and retained-checkpoint approximations.'
    if (exact) return 'Whole-cycle duration uses reported rolling windows.'
    if (approximate) return 'Whole-cycle duration is approximated from retained checkpoints.'
    if (points.some((point) => point.rate !== undefined)) return 'Whole-cycle duration is unavailable.'
    return 'Simulation-speed telemetry was not reported.'
  }

  function queueTelemetryMode(points) {
    const measured = points.filter((point) => hasMeasurements(point, QUEUE_FIELDS))
    if (measured.length === 0) return 'unavailable'
    const peakPoints = measured.filter((point) => point.peak).length
    if (peakPoints === measured.length) return 'maxima'
    if (peakPoints === 0) return 'snapshots'
    return 'mixed'
  }

  function queueTelemetryCopy(mode) {
    if (mode === 'maxima') return 'Per-metric interval maxima between retained checkpoints.'
    if (mode === 'snapshots') return 'Settled queue snapshots only; interval maxima are unavailable.'
    if (mode === 'mixed') return 'Mixed report: some checkpoints contain interval maxima and others contain settled snapshots.'
    return 'Queue telemetry was not reported.'
  }

  function table(tableNode, captionText, headers, rows) {
    setText(element(tableNode.getAttribute('aria-labelledby')), captionText)
    const head = document.createElement('thead')
    const headerRow = document.createElement('tr')
    for (const header of headers) {
      const cell = create('th', '', header)
      cell.scope = 'col'
      headerRow.append(cell)
    }
    head.append(headerRow)
    const body = document.createElement('tbody')
    if (rows.length === 0) {
      const row = document.createElement('tr')
      const cell = create('td', 'table-zero', 'No data reported')
      cell.colSpan = headers.length
      row.append(cell)
      body.append(row)
    } else {
      for (const values of rows) {
        const row = document.createElement('tr')
        for (const value of values) row.append(create('td', '', value))
        body.append(row)
      }
    }
    tableNode.replaceChildren(head, body)
    updateTableOverflow(tableNode.parentElement)
  }

  function updateTableOverflow(region) {
    const hint = region.previousElementSibling
    const columns = region.scrollWidth > region.clientWidth
    const rows = region.scrollHeight > region.clientHeight
    hint.hidden = !rows && !columns
    setText(hint, rows && columns
      ? 'Scroll down for more checkpoints or across for more columns.'
      : rows
        ? 'Scroll down for more checkpoints.'
        : columns ? 'Scroll across for more columns.' : '', '')
  }

  function cssColor(name) {
    return getComputedStyle(root.host).getPropertyValue(name).trim()
  }

  function canvasContext(canvas) {
    const width = canvas.clientWidth || 600
    const height = canvas.clientHeight || (canvas.id === 'quote-chart' ? 260 : 240)
    const ratio = clamp(window.devicePixelRatio || 1, 1, 2)
    const nextWidth = Math.floor(width * ratio)
    const nextHeight = Math.floor(height * ratio)
    if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
      canvas.width = nextWidth
      canvas.height = nextHeight
    }
    const context = canvas.getContext('2d')
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, width, height)
    return { context, width, height }
  }

  function chartRect(width, height, overrides = {}) {
    return {
      left: overrides.left ?? 50,
      right: overrides.right ?? width - 13,
      top: overrides.top ?? 15,
      bottom: overrides.bottom ?? height - 31,
    }
  }

  function seriesMaximum(points, fields) {
    return Math.max(1, ...points.flatMap((point) => fields.map((field) => numeric(point[field]))))
  }

  function chartFont() {
    return `12px ${cssColor('--mono-font') || 'monospace'}`
  }

  function drawGrid(context, rect, maximum, formatter = compactNumber) {
    context.save()
    context.font = chartFont()
    context.fillStyle = cssColor('--quiet')
    context.strokeStyle = cssColor('--chart-grid')
    context.lineWidth = 1
    context.textAlign = 'right'
    context.textBaseline = 'middle'
    for (let index = 0; index <= 4; index++) {
      const ratio = index / 4
      const y = rect.bottom - (rect.bottom - rect.top) * ratio
      context.beginPath()
      context.moveTo(rect.left, Math.round(y) + 0.5)
      context.lineTo(rect.right, Math.round(y) + 0.5)
      context.stroke()
      context.fillText(formatter(maximum * ratio), rect.left - 8, y)
    }
    context.restore()
  }

  function xPositions(points, rect, byCycle) {
    if (points.length <= 1) return [rect.left + (rect.right - rect.left) / 2]
    const field = byCycle ? 'cycle' : 'checkpoint'
    const first = points[0][field]
    const span = points.at(-1)[field] - first
    return points.map((point) => rect.left + ((rect.right - rect.left) * (point[field] - first)) / span)
  }

  function drawXAxis(context, rect, points, positions, byCycle) {
    if (points.length === 0) return
    context.save()
    context.fillStyle = cssColor('--quiet')
    context.font = chartFont()
    context.textBaseline = 'top'
    const y = rect.bottom + 9
    const label = (point) => byCycle ? `cycle ${compactNumber(point.cycle)}` : point.label
    const first = label(points[0])
    const lastIndex = points.length - 1
    const span = rect.right - rect.left
    if (lastIndex === 0) {
      context.textAlign = 'center'
      context.fillText(first, positions[0], y, span)
    } else {
      const gap = 6
      const last = label(points[lastIndex])
      const firstWidth = context.measureText(first).width
      const lastWidth = context.measureText(last).width
      const scale = Math.min(1, (span - gap) / Math.max(1, firstWidth + lastWidth))
      context.textAlign = 'left'
      context.fillText(first, positions[0], y, Math.max(1, firstWidth * scale))
      const midIndex = Math.floor(lastIndex / 2)
      if (midIndex > 0) {
        const mid = label(points[midIndex])
        const midX = positions[midIndex]
        const midHalfWidth = context.measureText(mid).width / 2
        if (
          midX - midHalfWidth >= positions[0] + firstWidth * scale + gap &&
          midX + midHalfWidth <= positions[lastIndex] - lastWidth * scale - gap
        ) {
          context.textAlign = 'center'
          context.fillText(mid, midX, y)
        }
      }
      context.textAlign = 'right'
      context.fillText(last, positions[lastIndex], y, Math.max(1, lastWidth * scale))
    }
    context.restore()
  }

  function chartY(value, rect, maximum) {
    return rect.bottom - (rect.bottom - rect.top) * (value / maximum)
  }

  function chartSeries(field, rect, maximum, token) {
    return { field, rect, maximum, color: cssColor(token), pattern: SERIES_PATTERNS[token] }
  }

  function drawLine(context, points, positions, { rect, field, maximum, color, pattern }) {
    context.save()
    context.beginPath()
    context.lineJoin = 'round'
    context.lineCap = 'round'
    context.lineWidth = 1.75
    context.strokeStyle = color
    context.fillStyle = color
    context.setLineDash(pattern)
    const isolated = []
    let continuing = false
    points.forEach((point, index) => {
      const value = point[field]
      if (value === undefined) {
        continuing = false
        return
      }
      const x = positions[index]
      const y = chartY(value, rect, maximum)
      if (continuing) context.lineTo(x, y)
      else {
        context.moveTo(x, y)
        if (points[index + 1]?.[field] === undefined) isolated.push({ x, y })
      }
      continuing = true
    })
    context.stroke()
    for (const { x, y } of isolated) {
      context.beginPath()
      context.arc(x, y, 4, 0, 2 * Math.PI)
      context.fill()
    }
    context.restore()
  }

  function drawNoData(context, width, height, message) {
    context.save()
    context.fillStyle = cssColor('--quiet')
    context.font = chartFont()
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(message, width / 2, height / 2)
    context.restore()
  }

  function installChartCursor(canvas, tooltip, listen) {
    const wrapper = canvas.parentElement
    const guide = create('span', 'chart-guide')
    guide.setAttribute('aria-hidden', 'true')
    guide.hidden = true
    const announcement = create('span', 'sr-only')
    announcement.setAttribute('aria-live', 'polite')
    wrapper.append(guide, announcement)
    let model
    let selectedCheckpoint
    let pinned = false

    function clear() {
      guide.hidden = true
      tooltip.hidden = true
      announcement.textContent = ''
      selectedCheckpoint = undefined
      pinned = false
    }

    function show(index, announceCheckpoint = false) {
      const point = model?.points[index]
      if (!point) return
      selectedCheckpoint = point.checkpoint
      const x = model.positions[index]
      const { top, bottom } = model.rect
      tooltip.textContent = model.tooltip(point)
      tooltip.hidden = false
      guide.hidden = false
      guide.style.left = `${canvas.offsetLeft + x}px`
      guide.style.top = `${canvas.offsetTop + top}px`
      guide.style.height = `${bottom - top}px`
      const marks = model.series.flatMap((series) => {
        const value = point[series.field]
        if (value === undefined) return []
        const marker = create('span', 'chart-guide-marker')
        marker.style.top = `${chartY(value, series.rect, series.maximum) - top}px`
        marker.style.backgroundColor = series.color
        return [marker]
      })
      guide.replaceChildren(...marks)
      const roomRight = canvas.clientWidth - x - 12
      const tooltipWidth = tooltip.offsetWidth
      const onSide = roomRight >= tooltipWidth || x - 12 >= tooltipWidth
      const tooltipX = roomRight >= tooltipWidth ? x + 12 : Math.max(0, x - tooltipWidth - 12)
      tooltip.style.left = `${canvas.offsetLeft + tooltipX}px`
      tooltip.style.top = `${canvas.offsetTop + (onSide ? top + 8 : bottom + 8)}px`
      if (announceCheckpoint) announcement.textContent = tooltip.textContent.replaceAll('\n', '. ')
    }

    function nearest(event) {
      const x = event.clientX - canvas.getBoundingClientRect().left
      let index = 0
      for (let candidate = 1; candidate < model.positions.length; candidate++) {
        if (Math.abs(model.positions[candidate] - x) < Math.abs(model.positions[index] - x)) index = candidate
      }
      return index
    }

    wrapper.addEventListener('pointermove', (event) => {
      if (event.pointerType === 'mouse' && model?.points.length) show(nearest(event))
    }, listen)
    wrapper.addEventListener('pointerleave', () => {
      if (!pinned) clear()
    }, listen)
    wrapper.addEventListener('click', (event) => {
      if (!model?.points.length) return
      pinned = true
      show(nearest(event), true)
    }, listen)
    wrapper.addEventListener('focus', () => {
      pinned = true
      show(Math.max(0, model?.points.findIndex((point) => point.checkpoint === selectedCheckpoint) ?? 0), true)
    }, listen)
    wrapper.addEventListener('blur', clear, listen)
    wrapper.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        clear()
        return
      }
      if (!model?.points.length) return
      const current = model.points.findIndex((point) => point.checkpoint === selectedCheckpoint)
      const last = model.points.length - 1
      let next
      if (event.key === 'Home') next = 0
      else if (event.key === 'End') next = last
      else if (event.key === 'ArrowLeft') next = Math.max(0, current - 1)
      else if (event.key === 'ArrowRight') next = Math.min(last, current + 1)
      else return
      event.preventDefault()
      pinned = true
      show(next, true)
    }, listen)
    chartCursors.set(canvas, (nextModel) => {
      model = nextModel
      if (selectedCheckpoint === undefined) return
      const index = model?.points.findIndex((point) => point.checkpoint === selectedCheckpoint) ?? -1
      if (index < 0) clear()
      else show(index)
    })
  }

  function drawQuoteChart(points, byCycle) {
    const canvas = dom['quote-chart']
    const { context, width, height } = canvasContext(canvas)
    if (!points.length) {
      drawNoData(context, width, height, 'Quote stock has not been reported')
      chartCursors.get(canvas)?.()
      canvas.setAttribute('aria-label', 'Quote stock telemetry has not been reported.')
      return
    }
    const rect = chartRect(width, height)
    const maximum = seriesMaximum(points, QUOTE_FIELDS)
    const positions = xPositions(points, rect, byCycle)
    drawGrid(context, rect, maximum)
    const series = [
      chartSeries('ended', rect, maximum, '--series-secondary'),
      chartSeries('live', rect, maximum, '--proof'),
    ]
    for (const line of series) drawLine(context, points, positions, line)
    drawXAxis(context, rect, points, positions, byCycle)
    const hasQuotes = points.some((point) => hasMeasurements(point, QUOTE_FIELDS))
    if (!hasQuotes) drawNoData(context, width, height, 'Quote stock has not been reported')
    chartCursors.get(canvas)?.({
      points,
      positions,
      rect,
      series,
      tooltip: (point) => `${point.label}\nLive ${formatReported(point.live)}\nEnded ${formatReported(point.ended)}`,
    })
    const last = points.at(-1)
    const summary = hasQuotes ? ` Latest: ${formatReported(last.live)} live and ${formatReported(last.ended)} ended.` : ' No quote stock reported.'
    canvas.setAttribute('aria-label', `Quote stock by ${byCycle ? 'cycle' : 'checkpoint order'}.${summary}`)
  }

  function queueSampleMode(point) {
    if (!hasMeasurements(point, QUEUE_FIELDS)) return 'Unavailable'
    return point.peak ? 'Per-metric maxima' : 'Settled snapshot'
  }

  function drawQueueChart(points, byCycle) {
    const canvas = dom['queue-chart']
    const { context, width, height } = canvasContext(canvas)
    if (!points.length) {
      drawNoData(context, width, height, 'Queue telemetry has not been reported')
      chartCursors.get(canvas)?.()
      canvas.setAttribute('aria-label', 'Queue telemetry has not been reported.')
      return
    }
    const rect = chartRect(width, height)
    const maximum = seriesMaximum(points, QUEUE_COUNT_FIELDS)
    const positions = xPositions(points, rect, byCycle)
    drawGrid(context, rect, maximum)
    const series = [
      chartSeries('scheduled', rect, maximum, '--series-neutral'),
      chartSeries('pending', rect, maximum, '--series-secondary'),
      chartSeries('outstanding', rect, maximum, '--proof'),
    ]
    for (const line of series) drawLine(context, points, positions, line)
    drawXAxis(context, rect, points, positions, byCycle)
    const hasCounts = points.some((point) => hasMeasurements(point, QUEUE_COUNT_FIELDS))
    const hasRunning = points.some((point) => point.running !== undefined)
    const noCounts = hasRunning ? 'Queue counts unavailable. See Data for running state.' : 'Queue telemetry has not been reported.'
    if (!hasCounts) drawNoData(context, width, height, noCounts)
    chartCursors.get(canvas)?.({
      points,
      positions,
      rect,
      series,
      tooltip: (point) =>
        `${point.label} · ${queueSampleMode(point)}\nOutstanding ${formatReported(point.outstanding)}\nWaiting ${formatReported(
          point.pending,
        )}\nScheduled ${formatReported(point.scheduled)}\nRunning ${formatReported(point.running)}`,
    })
    const outstanding = points.flatMap((point) => point.outstanding === undefined ? [] : [point.outstanding])
    const summary = outstanding.length ? ` Maximum reported outstanding: ${formatReported(Math.max(...outstanding))} actions.` : ''
    canvas.setAttribute('aria-label', hasCounts ? `Queue pressure by ${byCycle ? 'cycle' : 'checkpoint order'}.${summary}` : noCounts)
  }

  function drawBandLabel(context, label, x, y, color) {
    context.save()
    context.fillStyle = color
    context.font = chartFont()
    context.textAlign = 'left'
    context.textBaseline = 'top'
    context.fillText(label, x, y)
    context.restore()
  }

  function drawPaceChart(points, byCycle) {
    const canvas = dom['pace-chart']
    const { context, width, height } = canvasContext(canvas)
    if (points.length === 0) {
      drawNoData(context, width, height, 'Pace telemetry has not been reported')
      chartCursors.get(canvas)?.()
      canvas.setAttribute('aria-label', 'Pace telemetry has not been reported.')
      return
    }
    const upper = chartRect(width, height, { top: 22, bottom: Math.floor(height * 0.43) })
    const lower = chartRect(width, height, { top: Math.floor(height * 0.6), bottom: height - 31 })
    const positions = xPositions(points, upper, byCycle)
    const rateMaximum = seriesMaximum(points, ['rate'])
    const latencyMaximum = seriesMaximum(points, ['p50', 'p95'])
    drawGrid(context, upper, rateMaximum, (value) => value.toFixed(value >= 10 ? 0 : 1))
    drawGrid(context, lower, latencyMaximum, (value) => duration(value))
    const series = [
      chartSeries('rate', upper, rateMaximum, '--proof'),
      chartSeries('p95', lower, latencyMaximum, '--series-secondary'),
      chartSeries('p50', lower, latencyMaximum, '--series-neutral'),
    ]
    for (const line of series) drawLine(context, points, positions, line)
    drawBandLabel(context, 'Cycles per second', upper.left, 3, cssColor('--quiet'))
    drawBandLabel(context, 'Whole-cycle duration · p50 / p95', lower.left, lower.top - 18, cssColor('--quiet'))
    drawXAxis(context, lower, points, positions, byCycle)
    if (!points.some((point) => hasMeasurements(point, PACE_FIELDS))) {
      drawNoData(context, width, height, 'Speed telemetry has not been reported')
    }
    chartCursors.get(canvas)?.({
      points,
      positions,
      rect: { ...lower, top: upper.top },
      series,
      tooltip: (point) => `${point.label}\nThroughput ${rate(point.rate)}\nP50 ${duration(point.p50)}\nP95 ${duration(point.p95)}`,
    })
    const latest = points.at(-1)
    canvas.setAttribute(
      'aria-label',
      `Simulation throughput and whole-cycle duration by ${byCycle ? 'cycle' : 'checkpoint order'}. Latest: ${rate(latest.rate)}, p50 ${duration(latest.p50)}, p95 ${duration(latest.p95)}.`,
    )
  }

  function renderCharts(report) {
    const checkpoints = reportCheckpoints(report)
    const visible = state.chartWindow === 'all' ? checkpoints : checkpoints.slice(-state.chartWindow)
    const visibleCount = formatReported(visible.length)
    const retainedCount = formatReported(checkpoints.length)
    setText(dom['chart-window-summary'], !visible.length
      ? 'No retained checkpoints'
      : visible[0].snapshot
        ? 'Current snapshot · no retained checkpoints'
        : visible.length === checkpoints.length
          ? `All ${retainedCount} retained checkpoints`
          : `Latest ${visibleCount} of ${retainedCount} retained checkpoints`)
    const byCycle = visible.length > 0 &&
      (visible.length === 1 || visible[0].cycle < visible.at(-1).cycle) &&
      visible.every(({ cycle }, index) => cycle !== undefined && (index === 0 || cycle >= visible[index - 1].cycle))
    const selectPoints = (timeline) => visible.map(({ checkpoint }) => {
      const point = timeline[checkpoint - 1]
      if (byCycle) return point
      return { ...point, label: `checkpoint ${formatReported(checkpoint)}` }
    })
    const quotePoints = selectPoints(quoteTimeline(report, checkpoints))
    const pacePoints = selectPoints(paceTimeline(report, checkpoints))
    const queuePoints = selectPoints(queueTimeline(report, checkpoints))
    const paceCopy = paceTelemetryCopy(pacePoints)
    const queueCopy = queueTelemetryCopy(queueTelemetryMode(queuePoints))
    const axis = byCycle ? 'Cycle' : 'Checkpoint order'
    const windowCaption = (label) => visible.length === 0 ? label
      : visible[0].snapshot ? `${label} · Current snapshot`
        : timelineWindowCaption(label, visible.length, checkpoints.length)
    setText(dom['pace-telemetry-note'], paceCopy)
    setText(dom['queue-telemetry-note'], queueCopy)
    drawQuoteChart(quotePoints, byCycle)
    drawPaceChart(pacePoints, byCycle)
    drawQueueChart(queuePoints, byCycle)
    table(
      dom['quote-chart-table'],
      windowCaption('Quote stock'),
      [axis, 'Live', 'Ended'],
      quotePoints.map((point) => [point.label, formatReported(point.live), formatReported(point.ended)]),
    )
    table(
      dom['pace-chart-table'],
      `${windowCaption('Throughput and whole-cycle duration')}. ${paceCopy}`,
      [axis, 'Cycles/s', 'P50 (ms)', 'P95 (ms)', 'Duration data'],
      pacePoints.map((point) => [
        point.label, rate(point.rate), formatReported(point.p50), formatReported(point.p95),
        point.exact && point.approximate ? 'Reported and approximate'
          : point.exact ? 'Reported rolling window' : point.approximate ? 'Retained-checkpoint approximation' : 'Unavailable',
      ]),
    )
    table(
      dom['queue-chart-table'],
      `${windowCaption('Queue pressure')}. ${queueCopy}`,
      [axis, 'Outstanding', 'Waiting', 'Scheduled', 'Running', 'Queue sample'],
      queuePoints.map((point) => [
        point.label, formatReported(point.outstanding), formatReported(point.pending),
        formatReported(point.scheduled), formatReported(point.running), queueSampleMode(point),
      ]),
    )
  }

  // ---- Cycle explainer ----------------------------------------------------------------------------

  const STORY_STAGES = [
    'Pick one quote user + one hedger',
    'Try one generated quote',
    'Wait for resulting work to settle',
    'Run a due check with its own actors · revisit when available',
  ]

  function clearStoryMotion() {
    state.storyAnimation?.cancel()
    state.storyAnimation = null
    window.cancelAnimationFrame(state.storyFrame)
    state.storyFrame = 0
    if (dom['story-token']) {
      dom['story-token'].style.opacity = '0'
      dom['story-token'].style.transform = ''
    }
    for (const step of dom['story-track'].querySelectorAll('[data-story-step]')) step.classList.remove('is-active', 'is-complete')
  }

  function activateStoryStep(index) {
    const steps = [...dom['story-track'].querySelectorAll('[data-story-step]')]
    steps.forEach((step, stepIndex) => {
      step.classList.toggle('is-active', stepIndex === index)
      step.classList.toggle('is-complete', stepIndex < index)
    })
    setText(dom['story-stage-copy'], STORY_STAGES[index])
  }

  function playStory() {
    if (!dom.story.open) return
    clearStoryMotion()
    const steps = [...dom['story-track'].querySelectorAll('[data-story-step]')]
    if (steps.length === 0) return
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reducedMotion || typeof dom['story-token'].animate !== 'function') {
      steps.forEach((step) => step.classList.add('is-complete'))
      setText(dom['story-stage-copy'], 'One cycle moves through all four stages before it is counted.')
      return
    }
    const trackBounds = dom['story-track'].getBoundingClientRect()
    const tokenBounds = dom['story-token'].getBoundingClientRect()
    const coordinates = steps.map((step) => {
      const bounds = step.getBoundingClientRect()
      return {
        x: bounds.left - trackBounds.left + bounds.width / 2 - tokenBounds.width / 2,
        y: bounds.top - trackBounds.top + 18 - tokenBounds.height / 2,
      }
    })
    activateStoryStep(0)
    dom['story-token'].style.opacity = '1'
    const travel = 2_600
    const hold = 350
    const duration = travel + hold + 140
    const frames = coordinates.map((point, index) => ({
      transform: `translate(${point.x}px, ${point.y}px)`,
      opacity: 1,
      offset: (travel / duration) * index / Math.max(1, coordinates.length - 1),
    }))
    const arrival = frames.at(-1)
    const animation = dom['story-token'].animate(
      [...frames, { ...arrival, offset: (travel + hold) / duration }, { ...arrival, offset: 1, opacity: 0 }],
      { duration, fill: 'forwards' },
    )
    state.storyAnimation = animation
    let activeStep = 0
    function syncStage() {
      if (state.storyAnimation !== animation) return
      const progress = animation.effect.getComputedTiming().progress ?? 0
      const step = Math.round(Math.min(1, progress * duration / travel) * (steps.length - 1))
      if (step !== activeStep) {
        activeStep = step
        activateStoryStep(step)
      }
      state.storyFrame = window.requestAnimationFrame(syncStage)
    }
    state.storyFrame = window.requestAnimationFrame(syncStage)
    animation.addEventListener(
      'finish',
      () => {
        if (state.storyAnimation !== animation) return
        clearStoryMotion()
        steps.forEach((step) => step.classList.add('is-complete'))
        setText(dom['story-stage-copy'], 'Cycle settled. The next randomized cycle can now begin.')
      },
      { once: true },
    )
  }

  function renderStory(report) {
    const participants = participantSnapshot(report)
    const actors = [
      ...Array.from({ length: participants.userCount }, (_, index) => ['user', `U${index + 1}`, `Simulated user ${index + 1}`]),
      ...Array.from({ length: participants.hedgerCount }, (_, index) => ['hedger', `H${index + 1}`, `Simulated hedger ${index + 1}`]),
    ]
    dom['story-actors'].replaceChildren(
      ...actors.map(([kind, label, title]) => {
        const node = create('span', `story-actor story-actor--${kind}`, label)
        node.title = title
        return node
      }),
    )
  }

  // ---- Activity -----------------------------------------------------------------------------------

  /** Newest first, without queue bookkeeping. */
  function activityRecords(report) {
    const records = Array.isArray(report?.activity) ? report.activity : []
    return records
      .map((record) => ({ ...object(object(record).event), root: record?.root, elapsedMs: record?.elapsedMs }))
      .filter((item) => item.type !== 'pause' && item.phase !== 'queued' && item.phase !== 'started')
      .reverse()
  }

  function activityTone(item) {
    const phase = text(item.phase ?? item.status, '').toLowerCase()
    if (item.error !== undefined || phase === 'failed' || phase === 'timed_out') return 'bad'
    if (phase === 'settled_after_timeout' || phase === 'skipped') return 'warn'
    if (phase === 'succeeded' || phase === 'sent') return 'good'
    return 'neutral'
  }

  function activityTitle(item) {
    if (item.type === 'action') return `${stakeholderCopy(item.title, 'Action')} · ${humanize(item.phase).toLowerCase()}`
    if (item.type === 'state') return `Quote #${text(item.quoteId, '?')} → ${text(item.quoteStatus, 'state observed')}`
    if (item.type === 'operation') return `${humanize(item.operation)} · ${humanize(item.phase)}`
    if (item.type === 'decision') return `${humanize(item.actor)} decision · ${humanize(item.action)}`
    if (item.type === 'root') {
      const outcome = text(item.status, 'completed').toLowerCase()
      const copy = outcome === 'sent' ? 'Generated quote submitted' : outcome === 'discarded' ? 'Generated input discarded' : humanize(outcome)
      return `Simulation cycle #${text(item.index, '?')} · ${copy}`
    }
    return humanize(item.type || 'Activity')
  }

  function activityDetail(item) {
    if (item.detail !== undefined) return stakeholderCopy(item.detail, '')
    const parts = []
    if (item.type === 'root' && item.userId !== undefined && item.hedgerId !== undefined) parts.push(`${text(item.userId)} → ${text(item.hedgerId)}`)
    if (item.actorId !== undefined) parts.push(text(item.actorId))
    if (item.quoteId !== undefined) parts.push(`quote #${text(item.quoteId)}`)
    if (item.type === 'decision' && item.quoteStatus !== undefined) parts.push(`from ${text(item.quoteStatus)}`)
    if (item.reason !== undefined) parts.push(text(item.reason).replace(/[-_]+/g, ' '))
    if (optionalNumber(item.durationMs) !== undefined) parts.push(duration(item.durationMs))
    if (item.error !== undefined) parts.push(text(item.error))
    return parts.join(' · ')
  }

  function activityMatchesFilter(item, filter) {
    if (filter === 'quotes') return item.type === 'state' || item.quoteId !== undefined
    if (filter === 'actors') return item.type === 'action' || item.type === 'decision'
    if (filter === 'corners') return item.type === 'operation'
    if (filter === 'errors') return activityTone(item) === 'bad'
    return true
  }

  function renderActivity(report) {
    const records = activityRecords(report)
    const filteredRecords = records.filter((item) => activityMatchesFilter(item, state.activityFilter))
    const visibleRecords = filteredRecords.slice(0, state.activityVisible)
    const droppedActivity = numeric(report?.retention?.droppedActivity)
    setText(
      dom['activity-count'],
      filteredRecords.length === records.length
        ? `${compactNumber(records.length)} retained`
        : `${compactNumber(filteredRecords.length)}/${compactNumber(records.length)} retained`,
    )
    dom['activity-count'].title =
      `${compactNumber(visibleRecords.length)} shown${droppedActivity > 0 ? `; ${compactNumber(droppedActivity)} raw events not retained` : ''}`
    setText(dom['activity-retention-note'], `${compactNumber(droppedActivity)} older events omitted from this view.`)
    dom['activity-retention-note'].hidden = droppedActivity <= 0
    if (filteredRecords.length === 0) {
      const filterLabel = root.querySelector('[data-activity-filter][aria-pressed="true"]')?.textContent?.trim()
      dom['activity-list'].replaceChildren(
        create(
          'li',
          'empty-copy',
          state.activityFilter === 'all'
            ? 'No meaningful activity has been retained yet.'
            : `No activity matches ${filterLabel}. Select All to see every retained event.`,
        ),
      )
      dom['activity-more'].hidden = true
      dom['activity-footer'].hidden = true
      return
    }
    const markers = { good: '✓', bad: '×', warn: '!', neutral: '·' }
    const tags = { root: 'cycle', operation: 'high-risk' }
    dom['activity-list'].replaceChildren(
      ...visibleRecords.map((item) => {
        const tone = activityTone(item)
        const row = create('li', 'activity-item')
        row.dataset.tone = tone
        const copy = create('div', 'activity-item__copy')
        copy.append(create('p', 'activity-item__title', activityTitle(item)), create('p', 'activity-item__detail', activityDetail(item)))
        row.append(
          create('time', 'activity-item__time', optionalNumber(item.elapsedMs) !== undefined ? duration(item.elapsedMs) : '—'),
          create('span', 'activity-item__marker', markers[tone]),
          copy,
          create('span', 'activity-item__tag', item.sequence !== undefined ? `#${text(item.sequence)}` : (tags[item.type] ?? text(item.type, ''))),
        )
        return row
      }),
    )
    const remaining = filteredRecords.length - visibleRecords.length
    dom['activity-more'].hidden = remaining <= 0
    dom['activity-footer'].hidden = remaining <= 0
    setText(dom['activity-more'], `Show ${compactNumber(Math.min(ACTIVITY_PAGE_SIZE, remaining))} more · ${compactNumber(remaining)} remaining`)
  }

  // ---- Replay and storage -------------------------------------------------------------------------

  function renderReplay(report) {
    const replay = replayCommand(report)
    setText(dom['replay-command'], replay || 'Replay command is not available yet.')
    dom['replay-command'].translate = !replay
    dom['copy-replay-panel'].disabled = !replay
  }

  function retentionEntries(report) {
    const retention = object(report?.retention)
    if (Object.keys(retention).length === 0) return [['Mode', 'Unavailable']]
    const compacted =
      numeric(retention.droppedTimeline) > 0 ||
      numeric(retention.droppedActivity) > 0 ||
      numeric(retention.timelineStride) > numeric(retention.timelineEveryRoots)
    const entries = [
      ['Mode', retention.lastWriteError ? 'Write error' : retention.truncatedToByteCap ? 'Byte-capped' : compacted ? 'Compacted' : 'Exact'],
    ]
    for (const [label, key] of [
      ['Timeline cadence', 'timelineEveryRoots'],
      ['Timeline stride', 'timelineStride'],
      ['Timeline limit', 'maxTimeline'],
      ['Activity limit', 'maxActivity'],
      ['Dropped timeline', 'droppedTimeline'],
      ['Dropped activity', 'droppedActivity'],
    ]) {
      if (retention[key] !== undefined) entries.push([label, compactNumber(retention[key])])
    }
    if (retention.maxBytes !== undefined) entries.push(['Report byte cap', bytes(retention.maxBytes)])
    if (retention.lastWriteAt !== undefined) entries.push(['Last write', shortDate(retention.lastWriteAt)])
    if (retention.lastWriteError !== undefined) entries.push(['Write error', text(retention.lastWriteError)])
    return entries
  }

  function renderRetention(report) {
    dom['retention-list'].replaceChildren(
      ...retentionEntries(report).map(([label, value]) => {
        const row = create('div')
        row.append(create('dt', '', label), create('dd', '', value))
        return row
      }),
    )
  }

  function renderReport(report) {
    dom['waiting-state'].hidden = true
    dom.dashboard.hidden = false
    const coverage = coverageSnapshot(report)
    state.coverage = coverage
    renderRunHeader(report, coverage)
    renderProblems(report)
    renderKpis(report)
    renderStory(report)
    renderCoverageVerdict(coverage)
    renderOutcomes(report)
    renderConfidenceLimits(report)
    renderLifecycle(report)
    renderActionTypes(report)
    renderCorners(report)
    renderMix(report)
    renderActivity(report)
    renderReplay(report)
    renderRetention(report)
    window.requestAnimationFrame(() => {
      if (!disposed && state.report === report) renderCharts(report)
    })
  }

  // ---- Loading ------------------------------------------------------------------------------------

  function setExportAvailable(available) {
    dom['export-report'].disabled = !available
    dom['export-hint'].hidden = available
  }

  function showWaiting({ pending = true } = {}) {
    state.report = null
    state.reportKey = ''
    state.lastReportAt = 0
    state.reportPending = pending
    setExportAvailable(false)
    dom['waiting-state'].hidden = false
    dom.dashboard.hidden = true
  }

  /** Resolves to UNCHANGED on a 304, otherwise to the parsed body and its ETag. */
  async function fetchJson(url, etag) {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const headers = { Accept: 'application/json', Authorization: authorization }
      if (etag) headers['If-None-Match'] = etag
      const response = await fetch(url, { cache: 'no-store', headers, signal: controller.signal })
      if (response.status === 304) return UNCHANGED
      if (response.status === 204) return { payload: null }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return { payload: await response.json(), etag: response.headers?.get?.('ETag') ?? null }
    } finally {
      window.clearTimeout(timeout)
    }
  }

  function reportUrl() {
    return state.selectedRunId ? `/api/fuzz/runs/${encodeURIComponent(state.selectedRunId)}` : '/api/fuzz/report'
  }

  function reportTimestamp(report) {
    return timestampNumber(report?.updatedAt) ?? timestampNumber(report?.run?.finishedAt) ?? Date.now()
  }

  function showError(error) {
    state.error = error instanceof Error ? error.message : text(error, 'Unknown report error')
    dom['error-banner'].hidden = false
    dom['error-banner'].classList.toggle('error-banner--empty', state.report === null)
    if (state.report === null) {
      dom['waiting-state'].hidden = true
      dom.dashboard.hidden = true
      dom['follow-button'].disabled = true
    }
    const explanation = state.report
      ? 'Could not refresh the report. Showing the last report we received.'
      : state.selectedRunId || !state.following
        ? 'The local report service is unavailable. Select Retry to request the report again.'
        : 'The local report service is unavailable. This page will retry automatically.'
    setText(dom['error-message'], state.report ? explanation : `${explanation} (${state.error})`)
    updateConnection()
  }

  function clearError() {
    state.error = null
    dom['error-banner'].hidden = true
    dom['error-banner'].classList.remove('error-banner--empty')
    dom['follow-button'].disabled = false
  }

  async function loadReport({ force = false } = {}) {
    if (!force && !state.following && state.report !== null) return
    const url = reportUrl()
    const request = ++state.reportRequest
    if (force && !state.report && !state.error) {
      state.reportPending = true
      updateConnection()
    }
    try {
      const response = await fetchJson(url, state.report && state.etag?.url === url ? state.etag.tag : undefined)
      if (request !== state.reportRequest || disposed) return
      state.lastSuccessAt = Date.now()
      state.reportPending = false
      clearError()
      if (response === UNCHANGED) {
        updateConnection()
        return
      }
      state.etag = response.etag ? { url, tag: response.etag } : null
      if (!isReport(response.payload)) {
        showWaiting({ pending: false })
        updateConnection()
        return
      }
      const report = response.payload
      const key = reportKey(report)
      // An identical report is not drawn again, so a selection or an open disclosure survives the poll.
      const changed = state.report === null || key !== state.reportKey
      state.report = report
      state.reportKey = key
      state.lastReportAt = reportTimestamp(report)
      if (changed) {
        setExportAvailable(true)
        renderReport(report)
      }
      updateConnection()
    } catch (error) {
      if (request !== state.reportRequest || disposed) return
      state.reportPending = false
      showError(error)
    }
  }

  function runId(run) {
    return text(run?.name ?? run?.id, '')
  }

  /** Build the report option from the local date and available metadata. */
  function runLabel(run) {
    const name = runId(run)
    const status = text(run.status, '').toLowerCase()
    const archiveMatch = name.match(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2}(?:\.\d+)?)Z-([a-f0-9]{6,})\.json$/i)
    const started = shortDate(run.startedAt) || (archiveMatch ? shortDate(`${archiveMatch[1]}:${archiveMatch[2]}:${archiveMatch[3]}Z`) : '')
    if (!status && run.seed === undefined && archiveMatch) return `${started} · ${archiveMatch[4].slice(0, 8)} · archived`
    const failures = optionalNumber(run.failures)
    const outcome =
      status === 'failed' ? `Failed${failures ? `, ${plural(failures, 'failure')}` : ''}` : status ? humanize(status) : 'Outcome unknown'
    const parts = [started || name, outcome, run.cycles !== undefined && plural(run.cycles, 'cycle'), run.seed && `seed ${run.seed}`]
    return `${status === 'failed' ? '× ' : ''}${parts.filter(Boolean).join(' · ')}`
  }

  function renderRunOptions() {
    const currentValue = state.selectedRunId
    const options = [new Option('Current run', '')]
    for (const run of state.runs) {
      const id = runId(run)
      if (id) options.push(new Option(runLabel(run), id))
    }
    dom['run-select'].replaceChildren(...options)
    if ([...dom['run-select'].options].some((option) => option.value === currentValue)) dom['run-select'].value = currentValue
    else {
      state.selectedRunId = ''
      state.following = true
      state.activityVisible = ACTIVITY_PAGE_SIZE
      dom['run-select'].value = ''
      showWaiting()
      updateConnection()
      if (currentValue) void loadReport({ force: true })
    }
  }

  async function loadRuns() {
    if (runsLoading) return
    runsLoading = true
    try {
      const { payload } = await fetchJson('/api/fuzz/runs')
      if (disposed) return
      const runs = Array.isArray(payload?.runs) ? payload.runs : []
      state.runs = runs.map((item) => (isObject(item) ? item : { name: item }))
      renderRunOptions()
      if (root.activeElement === dom['archive-retry']) dom['run-select'].focus()
      dom['archive-retry'].hidden = true
      delete dom['archive-feedback'].dataset.error
      setText(dom['archive-message'], '', '')
    } catch {
      if (disposed) return
      dom['archive-feedback'].dataset.error = 'true'
      dom['archive-retry'].hidden = false
      setText(dom['archive-message'], 'Could not load past reports.')
    } finally {
      runsLoading = false
    }
  }

  // ---- Connection and controls --------------------------------------------------------------------

  function updateFollowButton() {
    const following = state.following && !state.selectedRunId
    dom['run-select'].dataset.archived = String(Boolean(state.selectedRunId))
    setText(dom['follow-button-label'], following ? 'Pause updates' : 'Follow live')
    dom['follow-button'].title = following ? 'Pause automatic report updates' : 'Return to the current report'
  }

  function updateConnection() {
    const runFailed = runStatus(state.report) === 'failed'
    let connectionState = 'waiting'
    const selectedLabel = state.selectedRunId ? dom['run-select'].selectedOptions[0]?.textContent || state.selectedRunId : ''
    const loadingLabel = state.selectedRunId ? 'Loading saved report…' : 'Loading current report…'
    const emptyLabel = state.selectedRunId ? 'No saved report available' : 'Waiting for a run report'
    let label = state.reportPending ? loadingLabel : emptyLabel
    let detail = selectedLabel
    if (!state.report) {
      setText(dom['waiting-title'], label)
      dom['start-guidance'].hidden = state.reportPending || Boolean(state.selectedRunId) || Boolean(state.error)
    }
    if (state.error) {
      connectionState = 'error'
      label = 'Report error'
      detail = selectedLabel ? `${selectedLabel} · ${state.error}` : state.error
    } else if (!state.report) {
      connectionState = 'waiting'
    } else if (!state.following || state.selectedRunId) {
      connectionState = 'frozen'
      label = state.selectedRunId ? 'Past report' : 'Updates paused'
      detail = selectedLabel || 'Automatic report updates are paused'
    } else if (isTerminalRun(state.report)) {
      connectionState = 'final'
      label = 'Final report'
      const finished = ago(timestampNumber(state.report.run?.finishedAt) ?? state.lastReportAt)
      detail = runFailed ? `Finished ${finished}` : `Run ${humanize(runStatus(state.report)).toLowerCase()} ${finished}`
    } else if (isLiveRun(state.report) && state.lastReportAt > 0 && Date.now() - state.lastReportAt > STALE_AFTER_MS) {
      connectionState = 'stale'
      label = 'Report stale'
      detail = `Last report update ${ago(state.lastReportAt)}`
    } else if (state.lastSuccessAt > 0) {
      connectionState = 'ready'
      label = 'Report connected'
      detail = `Updated ${ago(state.lastReportAt || state.lastSuccessAt)}`
    }
    dom['connection-banner'].dataset.state = connectionState
    dom['connection-banner'].dataset.outcome = runFailed ? 'failed' : ''
    if (runFailed) {
      detail = `${label} · ${detail}`
      label = 'Run failed'
    }
    const changed =
      state.connectionState && (state.connectionState !== connectionState || dom['connection-label'].textContent !== label)
    setText(dom['connection-label'], label)
    setText(dom['connection-detail'], detail, '')
    if (changed) announce(detail ? `${label}. ${detail}.` : label)
    state.connectionState = connectionState
    updateFollowButton()
    if (!state.report) return
    renderCoverageMessage(state.coverage, connectionState)
    renderOutcomeFreshness(state.report, connectionState)
    const acceptedAge = ago(state.lastReportAt || state.lastSuccessAt)
    renderRunStatus(state.report, connectionState)
    setText(dom['run-title'], runHeadline(state.report, connectionState))
    renderRunMetadata(state.report)
    const total = quoteTotals(state.report.latest?.quotes).total
    const quoteSummary =
      total !== undefined
        ? `${compactNumber(total)} tracked quotes · configured targets, not exhaustive coverage`
        : 'Configured run targets, not exhaustive protocol coverage'
    const freshness =
      connectionState === 'stale'
        ? `stale snapshot from ${acceptedAge}`
        : connectionState === 'frozen'
          ? state.selectedRunId
            ? `archived snapshot from ${acceptedAge}`
            : `updates paused at ${acceptedAge}`
          : connectionState === 'error'
            ? `last accepted snapshot from ${acceptedAge}`
            : connectionState === 'final'
              ? 'final report'
              : `updated ${acceptedAge}`
    setText(dom['health-note'], `${quoteSummary} · ${freshness}`)
  }

  function exportFilename(report) {
    const safeSource =
      text(seedOf(report) || state.selectedRunId, 'run')
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 72) || 'run'
    return `symmio-fuzz-${safeSource}.json`
  }

  function exportReport() {
    if (!state.report) return
    try {
      const url = URL.createObjectURL(new Blob([`${JSON.stringify(state.report, null, 2)}\n`], { type: 'application/json' }))
      const link = document.createElement('a')
      link.href = url
      link.download = exportFilename(state.report)
      link.hidden = true
      document.body.append(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
      announce(`Exported ${link.download}.`)
    } catch {
      announce('The current report could not be exported.')
    }
  }

  function updateChartWindowButtons() {
    for (const button of root.querySelectorAll('[data-chart-window]')) {
      const value = button.dataset.chartWindow === 'all' ? 'all' : numeric(button.dataset.chartWindow)
      button.setAttribute('aria-pressed', value === state.chartWindow ? 'true' : 'false')
    }
  }

  function updateActivityFilterButtons() {
    for (const button of root.querySelectorAll('[data-activity-filter]')) {
      button.setAttribute('aria-pressed', button.dataset.activityFilter === state.activityFilter ? 'true' : 'false')
    }
  }

  function activateDetailsTab(tabName, { focus = false } = {}) {
    const buttons = [...root.querySelectorAll('[data-details-tab]')]
    const selectedButton = buttons.find((button) => button.dataset.detailsTab === tabName)
    if (!selectedButton) return
    const scroll = window.scrollY
    const details = selectedButton.closest('#details')
    const reserve = dom['details-scroll-reserve']
    const previousHeight = details.offsetHeight
    const previousMax = document.documentElement.scrollHeight - document.documentElement.clientHeight - reserve.offsetHeight
    state.detailsTab = tabName
    for (const button of buttons) {
      const selected = button === selectedButton
      button.setAttribute('aria-selected', selected ? 'true' : 'false')
      button.tabIndex = selected ? 0 : -1
    }
    for (const pane of root.querySelectorAll('[data-details-pane]')) pane.hidden = pane.dataset.detailsPane !== tabName
    // Preserve the tab row when the browser would clamp scroll for a shorter pane.
    const naturalMax = previousMax + details.offsetHeight - previousHeight
    const deficit = scroll > 0 ? Math.max(0, scroll - naturalMax) : 0
    reserve.style.height = deficit ? `${deficit}px` : ''
    if (deficit) reserve.dataset.scrollMax = String(naturalMax)
    else delete reserve.dataset.scrollMax
    if (window.scrollY !== scroll) window.scrollTo({ top: scroll, behavior: 'instant' })
    if (focus) selectedButton.focus({ preventScroll: true })
    if (tabName === 'runner' && state.report) renderCharts(state.report)
  }

  function handleDetailsTabKeydown(event) {
    const buttons = [...root.querySelectorAll('[data-details-tab]')]
    const currentIndex = buttons.indexOf(event.currentTarget)
    if (currentIndex < 0) return
    let nextIndex
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % buttons.length
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + buttons.length) % buttons.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = buttons.length - 1
    else return
    event.preventDefault()
    activateDetailsTab(buttons[nextIndex].dataset.detailsTab, { focus: true })
  }

  function scheduleChartRender() {
    if (!state.report || state.resizeFrame) return
    state.resizeFrame = window.requestAnimationFrame(() => {
      state.resizeFrame = 0
      renderCharts(state.report)
    })
  }

  function switchTo(runName) {
    state.selectedRunId = runName
    state.following = true
    state.etag = null
    state.activityVisible = ACTIVITY_PAGE_SIZE
    state.problemRun = ''
    dom['run-select'].value = runName
    showWaiting()
    updateConnection()
    void loadReport({ force: true })
  }

  function bindEvents() {
    const listen = { signal: lifetime.signal }
    dom['follow-button'].addEventListener('click', () => {
      if (state.following && !state.selectedRunId) {
        state.following = false
        announce('Updates paused. The displayed report will not change.')
        updateConnection()
        return
      }
      announce('Following the current report.')
      switchTo('')
    })
    dom['run-select'].addEventListener('change', () => switchTo(dom['run-select'].value))
    dom['archive-retry'].addEventListener('click', () => void loadRuns(), listen)
    dom['retry-button'].addEventListener('click', async () => {
      if (state.retrying) return
      const button = dom['retry-button']
      state.retrying = true
      button.disabled = true
      button.dataset.pending = ''
      setText(button, 'Retrying…')
      announce('Retrying the report request.')
      try {
        await loadReport({ force: true })
      } finally {
        state.retrying = false
        button.disabled = false
        delete button.dataset.pending
        setText(button, 'Retry')
      }
    }, listen)
    dom['copy-replay-panel'].addEventListener('click', () =>
      copyWithFeedback(replayCommand(state.report), dom['copy-replay-panel'], 'Replay command'),
    )
    dom['problems-copy'].addEventListener('click', () => copyWithFeedback(replayCommand(state.report), dom['problems-copy'], 'Replay command'))
    dom['copy-start-command'].addEventListener('click', () =>
      copyWithFeedback(dom['start-command'].textContent, dom['copy-start-command'], 'Start command'),
    )
    dom['story-replay'].addEventListener('click', playStory)
    dom.story.addEventListener('toggle', () => (dom.story.open ? window.requestAnimationFrame(playStory) : clearStoryMotion()))
    dom['export-report'].addEventListener('click', exportReport)
    dom['activity-more'].addEventListener('click', () => {
      state.activityVisible += ACTIVITY_PAGE_SIZE
      if (state.report) renderActivity(state.report)
    })
    for (const button of root.querySelectorAll('[data-details-tab]')) {
      button.addEventListener('click', () => activateDetailsTab(button.dataset.detailsTab))
      button.addEventListener('keydown', handleDetailsTabKeydown)
    }
    window.addEventListener('scroll', () => {
      const reserve = dom['details-scroll-reserve']
      const max = reserve.dataset.scrollMax
      if (max !== undefined && window.scrollY <= Number(max)) {
        reserve.style.height = ''
        delete reserve.dataset.scrollMax
      }
    }, { ...listen, passive: true })
    for (const button of root.querySelectorAll('[data-chart-window]')) {
      button.addEventListener('click', () => {
        state.chartWindow = button.dataset.chartWindow === 'all' ? 'all' : numeric(button.dataset.chartWindow, 64)
        updateChartWindowButtons()
        if (state.report) renderCharts(state.report)
      })
    }
    for (const button of root.querySelectorAll('[data-activity-filter]')) {
      button.addEventListener('click', () => {
        state.activityFilter = button.dataset.activityFilter || 'all'
        state.activityVisible = ACTIVITY_PAGE_SIZE
        updateActivityFilterButtons()
        if (state.report) renderActivity(state.report)
      })
    }
    for (const [canvasId, tooltipId] of [
      ['quote-chart', 'quote-tooltip'],
      ['pace-chart', 'pace-tooltip'],
      ['queue-chart', 'queue-tooltip'],
    ]) {
      installChartCursor(dom[canvasId], dom[tooltipId], listen)
    }
    for (const disclosure of root.querySelectorAll('.chart-data')) {
      disclosure.addEventListener('toggle', () => updateTableOverflow(disclosure.querySelector('.table-scroll')), listen)
    }
    // In-page anchors cannot reach into a shadow root, so scroll explicitly.
    for (const link of root.querySelectorAll('.section-nav a')) {
      link.addEventListener('click', (event) => {
        event.preventDefault()
        const target = element(link.getAttribute('href').slice(1))
        if (!target || dom.dashboard.hidden) return
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
        target.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' })
      })
    }
    if ('ResizeObserver' in window) {
      resizeObserver = new ResizeObserver(scheduleChartRender)
      resizeObserver.observe(dom.dashboard)
    } else {
      window.addEventListener('resize', scheduleChartRender, listen)
    }
    window.matchMedia('(prefers-contrast: more)').addEventListener?.('change', scheduleChartRender, listen)
    window.addEventListener(
      'resize',
      () => {
        if (!state.storyAnimation) return
        clearStoryMotion()
        for (const step of dom['story-track'].querySelectorAll('[data-story-step]')) step.classList.add('is-complete')
        setText(dom['story-stage-copy'], 'Cycle settled. Replay the explanation to see each stage.')
      },
      listen,
    )
    // A hidden tab does not poll; coming back catches up at once.
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.visibilityState === 'visible') pollReport({ catchUp: true })
      },
      listen,
    )
  }

  /**
   * The current run is polled every two seconds while it runs. Once it has ended the report is final, and it is
   * only checked at the archive cadence in case a new run replaces it.
   */
  function pollReport({ catchUp = false } = {}) {
    if (document.visibilityState === 'hidden' || state.retrying || !state.following || state.selectedRunId) return
    if (!catchUp && state.report && isTerminalRun(state.report) && Date.now() - state.lastSuccessAt < RUNS_INTERVAL_MS) return
    void loadReport()
  }

  function startTimers() {
    state.pollTimer = window.setInterval(() => pollReport(), POLL_INTERVAL_MS)
    state.runsTimer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void loadRuns()
    }, RUNS_INTERVAL_MS)
    state.statusTimer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') updateConnection()
    }, 1_000)
  }

  function initialize() {
    cacheDom()
    bindEvents()
    activateDetailsTab(state.detailsTab)
    updateChartWindowButtons()
    updateActivityFilterButtons()
    setExportAvailable(false)
    updateConnection()
    void loadRuns()
    void loadReport({ force: true })
    startTimers()
  }

  function dispose() {
    disposed = true
    state.reportRequest++
    for (const timer of [state.pollTimer, state.runsTimer, state.statusTimer]) window.clearInterval(timer)
    for (const timer of copyTimers.values()) window.clearTimeout(timer)
    if (state.resizeFrame) window.cancelAnimationFrame(state.resizeFrame)
    clearStoryMotion()
    resizeObserver?.disconnect()
    lifetime.abort()
  }

  initialize()
  return {
    dispose,
    redraw() {
      if (state.report) renderCharts(state.report)
    },
  }
}
