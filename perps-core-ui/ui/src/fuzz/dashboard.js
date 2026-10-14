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

  // The runner writes the report at most every two seconds.
  const POLL_INTERVAL_MS = 2_000
  const RUNS_INTERVAL_MS = 12_000
  const FETCH_TIMEOUT_MS = 5_000
  const STALE_AFTER_MS = 5_000
  const COPIED_MS = 2_000
  const ACTIVITY_PAGE_SIZE = 12
  const UNCHANGED = Symbol('unchanged')

  const dom = {}
  const chartModels = new WeakMap()
  const copyTimers = new Map()
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
    pollTimer: null,
    statusTimer: null,
    runsTimer: null,
    resizeFrame: 0,
    chartWindow: 64,
    activityFilter: 'all',
    activityVisible: ACTIVITY_PAGE_SIZE,
    detailsTab: 'coverage',
    connectionState: '',
    storyAnimation: null,
    storyTimers: [],
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
      'follow-button',
      'follow-button-label',
      'export-report',
      'export-hint',
      'waiting-state',
      'copy-start-command',
      'start-command',
      'error-banner',
      'error-message',
      'retry-button',
      'dashboard',
      'details',
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
      'summary-limit-note',
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
      'footer-source',
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
    return new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(timestamp))
  }

  function shortDate(value) {
    const timestamp = timestampNumber(value)
    if (timestamp === undefined) return ''
    return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(
      new Date(timestamp),
    )
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
    setText(dom['run-status'], `${snapshot ? 'Last reported: ' : ''}${outcome.label}`.toUpperCase())
    dom['run-status'].dataset.tone = snapshot && outcome.tone !== 'bad' ? 'warn' : outcome.tone
  }

  function renderRunHeader(report) {
    const mode = report?.run?.config?.runMode
    const trace = text(report?.run?.traceHash, '')
    renderRunStatus(report)
    setText(dom['run-mode'], humanRunMode(mode))
    setText(dom['run-title'], runHeadline(report, state.connectionState))
    setText(dom['run-subtitle'], runSummary(report, viewNow(report)))
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

  function failureItem(failure) {
    const node = create('li', 'problem')
    const where = [
      failure.cycle !== undefined && `cycle ${compactNumber(failure.cycle)}`,
      failure.actionSequence !== undefined && `action #${failure.actionSequence}`,
      failure.actionTitle,
    ].filter(Boolean)
    node.append(create('p', 'problem__boundary', humanize(failure.boundary)), create('p', 'problem__message', failure.message))
    if (where.length) node.append(create('p', 'problem__where', `During ${where.join(' · ')}`))
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
    const show = signals.hasFailure || Boolean(signals.storageWarning)
    dom.problems.hidden = !show
    if (!show) return
    dom.problems.dataset.tone = signals.hasFailure ? 'bad' : 'warn'
    setText(
      dom['problems-count'],
      failures.length
        ? plural(failures.length, 'failure')
        : signals.hasFailure
          ? plural(signals.failureCategories.length, 'signal')
          : 'Storage warning',
    )
    const items = failures.slice(-10).reverse().map(failureItem)
    if (failures.length === 0 && signals.hasFailure) {
      const node = create('li', 'problem')
      node.append(
        create('p', 'problem__boundary', 'Run signals'),
        create('p', 'problem__message', signals.failureCategories.join(' · ')),
        create('p', 'problem__where', isTerminalRun(report) ? 'The report kept no failure detail.' : 'Failure detail arrives when the run ends.'),
      )
      items.push(node)
    }
    if (signals.storageWarning) {
      const node = create('li', 'problem')
      node.dataset.tone = 'warn'
      node.append(create('p', 'problem__boundary', 'Report storage'), create('p', 'problem__message', signals.storageWarning))
      items.push(node)
    }
    // Rebuilding the list on every poll would close an open stack disclosure, so only rebuild when it changed.
    const signature = JSON.stringify([failures, signals.failureCategories, signals.storageWarning])
    if (dom['problems-list'].dataset.signature !== signature) {
      dom['problems-list'].dataset.signature = signature
      dom['problems-list'].replaceChildren(...items)
    }
    const replay = replayCommand(report)
    setText(dom['problems-seed'], seedOf(report))
    dom['problems-copy'].disabled = !replay
    setText(dom['problems-replay-note'], replay ? '' : 'The replay command is written when the run ends.', '')
    dom['problems-replay-note'].hidden = Boolean(replay)
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
        value: yieldSnapshot?.ratio === undefined ? '—' : percent(yieldSnapshot.ratio),
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
        detail: actions.available ? 'Each supported type checked at least once' : 'State-check evidence unavailable',
        tone: actions.available && actions.missing.length === 0 ? 'good' : 'warn',
      },
      {
        label: 'High-risk checks',
        value: cornersAvailable ? `${compactNumber(corners.succeeded)}/${compactNumber(corners.attempted)}` : '—',
        detail: cornersAvailable ? `${cornerTypes}/${cornerTargetList.length} workflow types passed` : 'Workflow evidence unavailable',
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
    const blockedProbability = optionalNumber(report?.run?.config?.blockedQuoteProbability)
    setText(
      dom['summary-limit-note'],
      `Configured targets only${
        blockedProbability === 0
          ? ' · blocked generation off'
          : blockedProbability !== undefined
            ? ` · blocked generation ${percent(blockedProbability)}`
            : ''
      }`,
    )
  }

  // ---- Coverage -----------------------------------------------------------------------------------

  function renderCoverageVerdict(report) {
    const coverage = coverageSnapshot(report)
    const container = dom['coverage-status'].closest('.coverage-verdict')
    if (container) container.dataset.tone = coverage.tone
    setText(dom['coverage-verdict-title'], coverage.title)
    setText(dom['coverage-status'], coverage.label)
    dom['coverage-status'].dataset.tone = coverage.tone
    setText(dom['coverage-summary'], coverage.summary)
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
    dom['coverage-gaps'].replaceChildren(
      ...coverage.gaps.map((gap) => {
        const node = create('span', 'coverage-gap', gap.label)
        node.dataset.tone = gap.tone
        node.setAttribute('role', 'listitem')
        return node
      }),
    )
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
    setText(dom['quotes-title'], totals.total === undefined ? 'Quote outcomes' : `Where ${compactNumber(totals.total)} quotes ended up`)
    if (!hasQuoteStatusBreakdown(quotes)) {
      dom['outcome-bar'].replaceChildren()
      dom['outcome-bar'].setAttribute('aria-label', 'Quote outcome distribution unavailable')
      dom['outcome-strip'].replaceChildren(
        create(
          'p',
          'empty-copy',
          totals.total === undefined
            ? 'A per-state quote outcome breakdown is unavailable.'
            : `${compactNumber(totals.total)} quotes were reported, but the per-state outcome breakdown is unavailable.`,
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
      { label: 'Liquidated', value: valueFor('LIQUIDATED'), tone: warnIfAny('LIQUIDATED') },
      { label: 'Expired', value: valueFor('EXPIRED'), tone: warnIfAny('EXPIRED') },
      { label: 'Liquidated before opening', value: valueFor('LIQUIDATED_PENDING'), tone: warnIfAny('LIQUIDATED_PENDING') },
    ]
    const distributionTotal = outcomes.reduce((sum, outcome) => sum + numeric(outcome.value), 0)
    dom['outcome-bar'].replaceChildren(
      ...(distributionTotal > 0
        ? outcomes
            .filter((outcome) => numeric(outcome.value) > 0)
            .map((outcome) => {
              const segment = create('span', 'outcome-bar__segment')
              segment.dataset.tone = outcome.tone
              segment.style.flexBasis = `${(numeric(outcome.value) / distributionTotal) * 100}%`
              segment.title = `${outcome.label}: ${compactNumber(outcome.value)}`
              return segment
            })
        : []),
    )
    dom['outcome-bar'].setAttribute(
      'aria-label',
      outcomes
        .filter((outcome) => outcome.value !== undefined)
        .map((outcome) => `${outcome.label} ${compactNumber(outcome.value)}`)
        .join(', '),
    )
    dom['outcome-strip'].replaceChildren(
      ...outcomes.map((outcome) => {
        const node = create('article', 'outcome-card')
        node.dataset.tone = outcome.tone
        node.append(
          create('p', 'outcome-card__value', outcome.value === undefined ? '—' : compactNumber(outcome.value)),
          create('p', 'outcome-card__label', outcome.label),
        )
        return node
      }),
    )
    if (totals.active === undefined) {
      setText(dom['outcome-note'], 'The active-quote count is unavailable; unknown fields are not treated as zero.')
      return
    }
    setText(
      dom['outcome-note'],
      isLiveRun(report)
        ? `${compactNumber(totals.active)} active now`
        : report?.run?.config?.runMode === 'continuous'
          ? `${compactNumber(totals.active)} still active at stop · not failures`
          : `${compactNumber(totals.active)} still active in the final snapshot`,
    )
  }

  function mixBlock(label, value, detail, ratioValue, tone) {
    const node = create('div', 'mix-block')
    node.append(create('p', 'mix-block__label', label), create('p', 'mix-block__value', value), create('p', 'mix-block__detail', detail))
    if (ratioValue !== undefined) {
      const meter = create('div', 'mix-meter')
      const fill = create('div', 'mix-meter__fill')
      if (tone) fill.style.background = tone
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
      const [limit, market, bestEffort] = ['LIMIT', 'MARKET', 'MARKET_BEST_EFFORT'].map((key) => optionalNumber(source[key]))
      const complete = limit !== undefined && market !== undefined && bestEffort !== undefined
      return {
        value: complete ? `${compactNumber(limit)} / ${compactNumber(market)} / ${compactNumber(bestEffort)}` : '—',
        ratio: complete ? (limit + market + bestEffort === 0 ? 0 : limit / (limit + market + bestEffort)) : undefined,
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
      mixBlock('Opening limit / market / best effort', openModes.value, 'First-seen order mode', openModes.ratio, cssColor('--proof')),
      mixBlock('Closing limit / market / best effort', closeModes.value, 'Live close requests only', closeModes.ratio, cssColor('--warn')),
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

  function windowedTimeline(points) {
    if (state.chartWindow === 'all') return points
    return points.slice(-Math.max(1, numeric(state.chartWindow, 64)))
  }

  function timelineWindowCaption(label, visible, total) {
    if (visible >= total) return `${label} across all ${compactNumber(total)} retained checkpoints`
    return `${label}; latest ${compactNumber(visible)} of ${compactNumber(total)} retained checkpoints`
  }

  function paceTelemetryMode(points) {
    if (points.length === 0) return 'unavailable'
    const exactPoints = points.filter((point) => point.exact).length
    if (exactPoints === points.length) return 'exact'
    if (exactPoints === 0) return 'legacy'
    return 'mixed'
  }

  function paceTelemetryCopy(mode) {
    if (mode === 'exact') return 'Whole-cycle duration uses the exact rolling window reported at each checkpoint.'
    if (mode === 'legacy') return 'Whole-cycle duration is approximated from retained checkpoints.'
    if (mode === 'mixed') return 'Mixed report: exact rolling-cycle duration and retained-checkpoint approximations.'
    return 'Simulation-speed telemetry was not reported.'
  }

  function queueTelemetryMode(points) {
    if (points.length === 0) return 'unavailable'
    const peakPoints = points.filter((point) => point.peak).length
    if (peakPoints === points.length) return 'maxima'
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
    const caption = create('caption', '', captionText)
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
    tableNode.replaceChildren(caption, head, body)
  }

  function cssColor(name) {
    return getComputedStyle(root.host).getPropertyValue(name).trim()
  }

  function canvasContext(canvas) {
    const width = Math.max(280, Math.floor(canvas.clientWidth || canvas.parentElement?.clientWidth || 600))
    const height = Math.max(220, Math.floor(canvas.clientHeight || 280))
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
    context.strokeStyle = cssColor('--rule-soft')
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

  function xPositions(points, rect) {
    if (points.length <= 1) return [rect.left + (rect.right - rect.left) / 2]
    return points.map((_, index) => rect.left + ((rect.right - rect.left) * index) / (points.length - 1))
  }

  function drawXAxis(context, rect, points, positions) {
    if (points.length === 0) return
    const indexes = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])]
    context.save()
    context.fillStyle = cssColor('--quiet')
    context.font = chartFont()
    context.textBaseline = 'top'
    for (const index of indexes) {
      context.textAlign = index === 0 ? 'left' : index === points.length - 1 ? 'right' : 'center'
      context.fillText(text(points[index].label, ''), positions[index], rect.bottom + 9)
    }
    context.restore()
  }

  function drawLine(context, points, positions, rect, field, maximum, color) {
    const yFor = (value) => rect.bottom - (rect.bottom - rect.top) * (numeric(value) / maximum)
    context.save()
    context.beginPath()
    context.lineJoin = 'round'
    context.lineCap = 'round'
    context.lineWidth = 1.75
    context.strokeStyle = color
    points.forEach((point, index) => {
      if (index === 0) context.moveTo(positions[index], yFor(point[field]))
      else context.lineTo(positions[index], yFor(point[field]))
    })
    if (points.length === 1) {
      context.moveTo(rect.left, yFor(points[0][field]))
      context.lineTo(rect.right, yFor(points[0][field]))
    }
    context.stroke()
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

  function installTooltip(canvas, tooltip) {
    if (canvas.dataset.tooltipReady === 'true') return
    canvas.dataset.tooltipReady = 'true'
    canvas.addEventListener('mousemove', (event) => {
      const model = chartModels.get(canvas)
      if (!model || model.points.length === 0) return
      const bounds = canvas.getBoundingClientRect()
      const x = event.clientX - bounds.left
      let nearest = 0
      let distance = Number.POSITIVE_INFINITY
      model.positions.forEach((position, index) => {
        const nextDistance = Math.abs(position - x)
        if (nextDistance < distance) {
          distance = nextDistance
          nearest = index
        }
      })
      tooltip.textContent = model.tooltip(model.points[nearest])
      tooltip.hidden = false
      const tooltipWidth = tooltip.offsetWidth || 200
      tooltip.style.left = `${clamp(model.positions[nearest] + 12, 8, Math.max(8, bounds.width - tooltipWidth - 8))}px`
      tooltip.style.top = `${Math.max(8, event.clientY - bounds.top - 20)}px`
    })
    canvas.addEventListener('mouseleave', () => {
      tooltip.hidden = true
    })
  }

  function drawQuoteChart(points) {
    const canvas = dom['quote-chart']
    const { context, width, height } = canvasContext(canvas)
    if (points.length === 0) {
      drawNoData(context, width, height, 'Quote stock has not been reported')
      chartModels.delete(canvas)
      canvas.setAttribute('aria-label', 'Quote stock telemetry has not been reported.')
      return
    }
    const rect = chartRect(width, height)
    const maximum = seriesMaximum(points, ['live', 'ended'])
    const positions = xPositions(points, rect)
    drawGrid(context, rect, maximum)
    drawLine(context, points, positions, rect, 'ended', maximum, cssColor('--series-secondary'))
    drawLine(context, points, positions, rect, 'live', maximum, cssColor('--proof'))
    drawXAxis(context, rect, points, positions)
    chartModels.set(canvas, {
      points,
      positions,
      tooltip: (point) => `${point.label}\nLive ${compactNumber(point.live)}\nEnded ${compactNumber(point.ended)}`,
    })
    canvas.setAttribute(
      'aria-label',
      `Quote stock over ${points.length} timeline buckets. Latest: ${compactNumber(points.at(-1).live)} live and ${compactNumber(points.at(-1).ended)} ended.`,
    )
  }

  function drawQueueChart(points) {
    const canvas = dom['queue-chart']
    const { context, width, height } = canvasContext(canvas)
    const mode = queueTelemetryMode(points)
    if (!points.length) {
      drawNoData(context, width, height, 'Queue telemetry has not been reported')
      chartModels.delete(canvas)
      canvas.setAttribute('aria-label', 'Queue telemetry has not been reported.')
      return
    }
    const observedMaximum = Math.max(
      ...points.flatMap((point) => [point.outstanding, point.pending, point.scheduled, point.running].map((value) => numeric(value))),
    )
    if (observedMaximum === 0) {
      drawNoData(
        context,
        width,
        height,
        mode === 'maxima' ? 'No queue pressure observed in retained intervals' : 'No pressure in retained queue telemetry',
      )
      chartModels.delete(canvas)
      canvas.setAttribute(
        'aria-label',
        mode === 'maxima'
          ? `No queue pressure was observed in the per-metric maxima for ${points.length} retained intervals.`
          : `No queue pressure appears in ${points.length} retained checkpoints.`,
      )
      return
    }
    const rect = chartRect(width, height)
    const maximum = seriesMaximum(points, ['outstanding', 'pending', 'scheduled'])
    const positions = xPositions(points, rect)
    drawGrid(context, rect, maximum)
    drawLine(context, points, positions, rect, 'outstanding', maximum, cssColor('--warn'))
    drawLine(context, points, positions, rect, 'pending', maximum, cssColor('--series-neutral'))
    drawLine(context, points, positions, rect, 'scheduled', maximum, cssColor('--proof'))
    drawXAxis(context, rect, points, positions)
    chartModels.set(canvas, {
      points,
      positions,
      tooltip: (point) =>
        `${point.label}${point.peak ? ' · per-metric interval maxima' : ' · settled snapshot'}\nOutstanding ${compactNumber(
          point.outstanding,
        )}\nWaiting ${compactNumber(point.pending)}\nScheduled ${compactNumber(point.scheduled)}\nRunning ${compactNumber(point.running)}`,
    })
    const peakOutstanding = Math.max(...points.map((point) => numeric(point.outstanding)))
    canvas.setAttribute(
      'aria-label',
      mode === 'maxima'
        ? `Queue per-metric interval maxima over ${points.length} retained checkpoints. Maximum outstanding: ${compactNumber(peakOutstanding)} actions.`
        : `Queue pressure across ${points.length} retained checkpoints. Maximum retained outstanding: ${compactNumber(peakOutstanding)} actions.`,
    )
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

  function drawPaceChart(points) {
    const canvas = dom['pace-chart']
    const { context, width, height } = canvasContext(canvas)
    if (points.length === 0) {
      drawNoData(context, width, height, 'Pace telemetry has not been reported')
      chartModels.delete(canvas)
      canvas.setAttribute('aria-label', 'Pace telemetry has not been reported.')
      return
    }
    const upper = chartRect(width, height, { top: 22, bottom: Math.floor(height * 0.43) })
    const lower = chartRect(width, height, { top: Math.floor(height * 0.6), bottom: height - 31 })
    const positions = xPositions(points, upper)
    const rateMaximum = seriesMaximum(points, ['rate'])
    const latencyMaximum = seriesMaximum(points, ['p50', 'p95'])
    drawGrid(context, upper, rateMaximum, (value) => value.toFixed(value >= 10 ? 0 : 1))
    drawGrid(context, lower, latencyMaximum, (value) => duration(value))
    drawLine(context, points, positions, upper, 'rate', rateMaximum, cssColor('--proof'))
    drawLine(context, points, positions, lower, 'p95', latencyMaximum, cssColor('--warn'))
    drawLine(context, points, positions, lower, 'p50', latencyMaximum, cssColor('--series-neutral'))
    drawBandLabel(context, 'Cycles per second', upper.left, 3, cssColor('--proof'))
    drawBandLabel(context, 'Whole-cycle duration · p50 / p95', lower.left, lower.top - 18, cssColor('--quiet'))
    drawXAxis(context, lower, points, positions)
    chartModels.set(canvas, {
      points,
      positions,
      tooltip: (point) => `${point.label}\nThroughput ${rate(point.rate)}\nP50 ${duration(point.p50)}\nP95 ${duration(point.p95)}`,
    })
    const latest = points.at(-1)
    canvas.setAttribute(
      'aria-label',
      `Simulation throughput and whole-cycle duration over ${points.length} timeline buckets. Latest: ${rate(latest.rate)}, p50 ${duration(
        latest.p50,
      )}, p95 ${duration(latest.p95)}.`,
    )
  }

  function renderCharts(report) {
    const allQuotePoints = quoteTimeline(report)
    const allPacePoints = paceTimeline(report)
    const allQueuePoints = queueTimeline(report)
    const quotePoints = windowedTimeline(allQuotePoints)
    const pacePoints = windowedTimeline(allPacePoints)
    const queuePoints = windowedTimeline(allQueuePoints)
    const paceMode = paceTelemetryMode(pacePoints)
    const queueMode = queueTelemetryMode(queuePoints)
    setText(dom['pace-telemetry-note'], paceTelemetryCopy(paceMode))
    dom['pace-telemetry-note'].dataset.tone = paceMode === 'exact' ? 'good' : paceMode === 'unavailable' ? 'neutral' : 'warn'
    setText(dom['queue-telemetry-note'], queueTelemetryCopy(queueMode))
    dom['queue-telemetry-note'].dataset.tone = queueMode === 'maxima' ? 'good' : queueMode === 'unavailable' ? 'neutral' : 'warn'
    drawQuoteChart(quotePoints)
    drawPaceChart(pacePoints)
    drawQueueChart(queuePoints)
    table(
      dom['quote-chart-table'],
      timelineWindowCaption('Quote stock', quotePoints.length, allQuotePoints.length),
      ['Bucket', 'Live', 'Ended'],
      quotePoints.map((point) => [point.label, compactNumber(point.live), compactNumber(point.ended)]),
    )
    table(
      dom['pace-chart-table'],
      timelineWindowCaption(
        paceMode === 'exact'
          ? 'Throughput and exact rolling-cycle duration'
          : paceMode === 'unavailable'
            ? 'Throughput and whole-cycle duration'
            : 'Throughput and approximate whole-cycle duration',
        pacePoints.length,
        allPacePoints.length,
      ),
      ['Bucket', 'Cycles/s', 'P50', 'P95'],
      pacePoints.map((point) => [point.label, rate(point.rate), duration(point.p50), duration(point.p95)]),
    )
    table(
      dom['queue-chart-table'],
      timelineWindowCaption(
        queueMode === 'maxima' ? 'Queue per-metric interval maxima' : queueMode === 'unavailable' ? 'Queue telemetry' : 'Queue snapshots and maxima',
        queuePoints.length,
        allQueuePoints.length,
      ),
      ['Checkpoint', 'Outstanding', 'Waiting', 'Scheduled', 'Running'],
      queuePoints.map((point) => [
        `${point.label} · ${point.peak ? 'per-metric maxima' : 'settled snapshot'}`,
        compactNumber(point.outstanding),
        compactNumber(point.pending),
        compactNumber(point.scheduled),
        compactNumber(point.running),
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
    for (const animation of dom['story-token']?.getAnimations?.() || []) animation.cancel()
    state.storyAnimation = null
    for (const timer of state.storyTimers) window.clearTimeout(timer)
    state.storyTimers = []
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
    state.storyAnimation = dom['story-token'].animate(
      coordinates.map((point, index) => ({
        transform: `translate(${point.x}px, ${point.y}px)`,
        offset: index / Math.max(1, coordinates.length - 1),
      })),
      { duration: 2_600, easing: 'cubic-bezier(0.77, 0, 0.175, 1)', fill: 'forwards' },
    )
    for (let index = 1; index < steps.length; index++) {
      state.storyTimers.push(window.setTimeout(() => activateStoryStep(index), Math.round((2_600 * index) / (steps.length - 1))))
    }
    state.storyAnimation.addEventListener(
      'finish',
      () => {
        steps.forEach((step) => {
          step.classList.remove('is-active')
          step.classList.add('is-complete')
        })
        setText(dom['story-stage-copy'], 'Cycle settled. The next randomized cycle can now begin.')
        const finishedAnimation = state.storyAnimation
        state.storyAnimation = null
        if (finishedAnimation) finishedAnimation.cancel()
        dom['story-token'].style.opacity = '0'
        dom['story-token'].style.transform = ''
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
      dom['activity-list'].replaceChildren(
        create(
          'li',
          'empty-copy',
          records.length === 0 ? 'No meaningful activity has been retained yet.' : 'No retained activity matches this filter.',
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
    renderRunHeader(report)
    renderProblems(report)
    renderKpis(report)
    renderStory(report)
    renderCoverageVerdict(report)
    renderOutcomes(report)
    renderConfidenceLimits(report)
    renderLifecycle(report)
    renderActionTypes(report)
    renderCorners(report)
    renderMix(report)
    renderActivity(report)
    renderReplay(report)
    renderRetention(report)
    setText(
      dom['footer-source'],
      state.selectedRunId ? `Source: /api/fuzz/runs/${state.selectedRunId} · archived run` : 'Source: /api/fuzz/report · current run',
    )
    window.requestAnimationFrame(() => {
      if (!disposed && state.report === report) renderCharts(report)
    })
  }

  // ---- Loading ------------------------------------------------------------------------------------

  function setExportAvailable(available) {
    dom['export-report'].disabled = !available
    dom['export-hint'].hidden = available
  }

  function showWaiting() {
    state.report = null
    state.reportKey = ''
    state.lastReportAt = 0
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
    setText(dom['error-message'], `${state.error}. The dashboard will retry automatically.`)
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
    try {
      const response = await fetchJson(url, state.report && state.etag?.url === url ? state.etag.tag : undefined)
      if (request !== state.reportRequest || disposed) return
      state.lastSuccessAt = Date.now()
      clearError()
      if (response === UNCHANGED) {
        updateConnection()
        return
      }
      state.etag = response.etag ? { url, tag: response.etag } : null
      if (!isReport(response.payload)) {
        showWaiting()
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
      showError(error)
    }
  }

  function runId(run) {
    return text(run?.name ?? run?.id, '')
  }

  /** "× Oct 14, 14:48 · Failed, 1 failure · 312 cycles · seed abc". Bare file names from an older server still read. */
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
    try {
      const { payload } = await fetchJson('/api/fuzz/runs')
      if (disposed) return
      const runs = Array.isArray(payload?.runs) ? payload.runs : []
      state.runs = runs.map((item) => (isObject(item) ? item : { name: item }))
      renderRunOptions()
    } catch {
      // A missing run archive must not interrupt the current live report.
    }
  }

  // ---- Connection and controls --------------------------------------------------------------------

  function updateFollowButton() {
    const following = state.following && !state.selectedRunId
    dom['follow-button'].setAttribute('aria-pressed', following ? 'true' : 'false')
    setText(dom['follow-button-label'], following ? 'Pause updates' : 'Follow live')
    dom['follow-button'].title = following ? 'Pause automatic report updates' : 'Return to the current report'
  }

  function updateConnection() {
    let connectionState = 'waiting'
    let label = 'Waiting for a report'
    let detail = 'Polling the local runner'
    if (state.error) {
      connectionState = 'error'
      label = 'Report error'
      detail = state.error
    } else if (!state.following || state.selectedRunId) {
      connectionState = 'frozen'
      label = state.selectedRunId ? 'Past report' : 'Updates paused'
      detail = state.selectedRunId ? `Showing run ${state.selectedRunId}` : 'Automatic report updates are paused'
    } else if (!state.report) {
      connectionState = 'waiting'
    } else if (isTerminalRun(state.report)) {
      connectionState = 'final'
      label = 'Final report'
      detail = `Run ${humanize(runStatus(state.report)).toLowerCase()} ${ago(timestampNumber(state.report.run?.finishedAt) ?? state.lastReportAt)}`
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
    setText(dom['connection-label'], label)
    setText(dom['connection-detail'], detail)
    if (state.connectionState && state.connectionState !== connectionState) announce(`${label}. ${detail}.`)
    state.connectionState = connectionState
    updateFollowButton()
    if (!state.report) return
    const acceptedAge = ago(state.lastReportAt || state.lastSuccessAt)
    renderRunStatus(state.report, connectionState)
    setText(dom['run-title'], runHeadline(state.report, connectionState))
    setText(dom['run-subtitle'], runSummary(state.report, viewNow(state.report)))
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
    state.detailsTab = tabName
    for (const button of buttons) {
      const selected = button === selectedButton
      button.setAttribute('aria-selected', selected ? 'true' : 'false')
      button.tabIndex = selected ? 0 : -1
    }
    for (const pane of root.querySelectorAll('[data-details-pane]')) pane.hidden = pane.dataset.detailsPane !== tabName
    if (focus) selectedButton.focus()
    if (tabName === 'runner') window.requestAnimationFrame(scheduleChartRender)
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
    dom['retry-button'].addEventListener('click', () => void loadReport({ force: true }))
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
    dom.details.addEventListener('toggle', () => {
      if (dom.details.open && state.detailsTab === 'runner') window.requestAnimationFrame(scheduleChartRender)
    })
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
      installTooltip(dom[canvasId], dom[tooltipId])
    }
    // In-page anchors cannot reach into a shadow root, so the section links scroll by hand.
    for (const link of root.querySelectorAll('.section-nav a')) {
      link.addEventListener('click', (event) => {
        event.preventDefault()
        const target = element(link.getAttribute('href').slice(1))
        if (!target) return
        if (target === dom.details) dom.details.open = true
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
    if (document.visibilityState === 'hidden' || !state.following || state.selectedRunId) return
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
