import { useEffect, useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip,
  XAxis, YAxis,
} from 'recharts';
import {
  Activity, AlertCircle, ArrowDownRight, ArrowUpRight, CalendarDays,
  CheckCircle2, Clock3, Database, Download, Gauge, RefreshCw, Wind,
} from 'lucide-react';

const API_BASE = import.meta.env.VITE_API_URL || '';
const backendHelp = API_BASE
  ? `Check the configured backend at ${API_BASE} and retry.`
  : 'Start the Python backend at http://127.0.0.1:8001 and retry.';
const number = (value, decimals = 0) => value == null || !Number.isFinite(Number(value))
  ? '—'
  : Number(value).toLocaleString('en-GB', { maximumFractionDigits: decimals, minimumFractionDigits: decimals });
const dateKey = (row) => row.startTime?.slice(0, 10) || '';
const dateLabel = (value) => new Date(`${value}T00:00:00Z`).toLocaleDateString('en-GB', {
  day: '2-digit', month: 'short', timeZone: 'UTC',
});
const timeLabel = (value) => new Date(value).toLocaleTimeString('en-GB', {
  hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
});
const PAGE_SIZE = 48;

async function readResponse(response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.detail || `Backend returned ${response.status}`);
  }
  return body;
}

function MetricCard({ label, value, unit, note, icon: Icon, tone = 'blue' }) {
  return (
    <article className={`metric-card tone-${tone}`}>
      <div className="metric-top"><span>{label}</span><span className="metric-icon"><Icon size={18} /></span></div>
      <div className="metric-value">{value}<small>{unit}</small></div>
      <div className="metric-note">{note}</div>
    </article>
  );
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <strong>{label}</strong>
      {payload.filter((entry) => entry.value != null).map((entry) => (
        <div className="tooltip-row" key={entry.dataKey}>
          <span className="tooltip-dot" style={{ background: entry.color }} />
          <span>{entry.name}</span>
          <b>{number(entry.value)} MW</b>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedDay, setSelectedDay] = useState('2026-01-02');
  const [activeView, setActiveView] = useState('overview');
  const [intervalMode, setIntervalMode] = useState('day');
  const [visibleRows, setVisibleRows] = useState(PAGE_SIZE);

  async function loadData(refresh = false) {
    setLoading(true);
    setError(null);
    try {
      if (refresh) {
        try {
          const response = await fetch(`${API_BASE}/api/refresh`, { method: 'POST' });
          await readResponse(response);
        } catch (err) {
          setError({ kind: 'refresh', message: err.message });
          return;
        }
      }
      const response = await fetch(`${API_BASE}/api/analysis`);
      const body = await readResponse(response);
      setPayload(body);
      const days = [...new Set((body.data || []).map(dateKey))].sort();
      if (days.length && !days.includes(selectedDay)) setSelectedDay(days[0]);
    } catch (err) {
      setError({
        kind: 'analysis',
        message: `${err.message}. ${backendHelp}`,
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadData(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = payload?.data || [];
  const metrics = payload?.metrics || {};
  const days = useMemo(() => [...new Set(rows.map(dateKey))].sort(), [rows]);
  const dayRows = useMemo(() => rows.filter((row) => dateKey(row) === selectedDay), [rows, selectedDay]);
  const chartRows = useMemo(() => dayRows.map((row) => ({
    ...row,
    label: timeLabel(row.startTime),
  })), [dayRows]);
  const matchedRows = useMemo(() => rows
    .filter((row) => row.forecastMW != null && row.actualMW != null)
    .map((row) => ({
      ...row,
      analyzedErrorMW: Number(row.forecastMW) - Number(row.actualMW),
    }))
    .filter((row) => Number.isFinite(row.analyzedErrorMW)), [rows]);
  const errorDistribution = useMemo(() => {
    const maxError = Math.max(0, ...matchedRows.map((row) => Math.abs(row.analyzedErrorMW)));
    const binCount = maxError === 0 ? 1 : 8;
    const binWidth = maxError / binCount || 1;
    const bins = Array.from({ length: binCount }, (_, index) => {
      const start = (maxError * index) / binCount;
      const end = (maxError * (index + 1)) / binCount;
      return {
        range: maxError === 0 ? '0 MW' : `${number(start, 1)}–${number(end, 1)} MW`,
        count: 0,
      };
    });
    matchedRows.forEach((row) => {
      const index = Math.min(binCount - 1, Math.floor(Math.abs(row.analyzedErrorMW) / binWidth));
      bins[index].count += 1;
    });
    return bins;
  }, [matchedRows]);
  const errorDirection = useMemo(() => matchedRows.reduce((counts, row) => {
    if (row.analyzedErrorMW > 0) counts.over += 1;
    else if (row.analyzedErrorMW < 0) counts.under += 1;
    else counts.exact += 1;
    return counts;
  }, { over: 0, under: 0, exact: 0 }), [matchedRows]);
  const intervalRows = intervalMode === 'all' ? rows.slice(0, visibleRows) : dayRows;

  function downloadCsv() {
    const header = ['deliveryDate', 'startTimeUTC', 'decisionDate', 'forecastPublishTime', 'forecastMW', 'actualMW', 'errorMW', 'absErrorMW'];
    const csvRows = rows.map((row) => header.map((key) => {
      const value = ({ startTimeUTC: row.startTime })[key] ?? row[key] ?? '';
      return `"${String(value).replaceAll('"', '""')}"`;
    }).join(','));
    const blob = new Blob([[header.join(','), ...csvRows].join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'uk-wind-forecast-accuracy-jan-2026.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup"><div className="brand-mark"><Wind size={23} /></div><div><strong>WINDLINE</strong><small>FORECAST INTELLIGENCE</small></div></div>
        <div className="sidebar-label">WORKSPACE</div>
        <button className={`nav-link${activeView === 'overview' ? ' selected' : ''}`} aria-current={activeView === 'overview' ? 'page' : undefined} onClick={() => setActiveView('overview')}><Activity size={17} /> Forecast overview{activeView === 'overview' && <span className="nav-indicator" />}</button>
        <button className={`nav-link${activeView === 'accuracy' ? ' selected' : ''}`} aria-current={activeView === 'accuracy' ? 'page' : undefined} onClick={() => setActiveView('accuracy')}><Gauge size={17} /> Accuracy analysis{activeView === 'accuracy' && <span className="nav-indicator" />}</button>
        <button className={`nav-link${activeView === 'intervals' ? ' selected' : ''}`} aria-current={activeView === 'intervals' ? 'page' : undefined} onClick={() => setActiveView('intervals')}><Database size={17} /> Interval data{activeView === 'intervals' && <span className="nav-indicator" />}</button>
        <div className="sidebar-bottom"><div className="status-orb"><span /></div><div><b>Data connection</b><small>{payload ? 'Elexon API connected' : 'Waiting for backend'}</small></div></div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">Energy analytics <span>/</span> Wind generation</div>
          <div className="topbar-actions"><span className="period-pill"><CalendarDays size={15} /> Jan 2026 decisions</span><button className="icon-button" title="Refresh data" onClick={() => loadData(true)} disabled={loading}><RefreshCw size={17} className={loading ? 'spin' : ''} /></button></div>
        </header>

        <section className="page-heading">
          <div><div className="eyebrow"><span className="eyebrow-dot" /> NATIONAL GRID · GREAT BRITAIN</div><h1>Wind forecast <em>{activeView === 'overview' ? 'overview' : activeView === 'accuracy' ? 'accuracy' : 'interval data'}</em></h1><p>Understand forecast reliability before day-ahead electricity purchasing decisions.</p></div>
          <button className="secondary-button" onClick={downloadCsv} disabled={!rows.length}><Download size={16} /> Export data</button>
        </section>

        {error && <div className={`error-banner ${error.kind === 'refresh' ? 'refresh-error' : ''}`} role="alert"><AlertCircle size={18} /><div><b>{error.kind === 'refresh' ? 'Unable to refresh data' : 'Unable to load analysis'}</b><span>{error.message}{payload && error.kind === 'refresh' ? ' Your previously loaded dashboard is still available.' : ''}</span></div><button onClick={() => loadData(error.kind === 'refresh')}>Retry</button></div>}
        {loading && !payload && <div className="loading-panel"><div className="loading-spinner" /><b>Loading January forecast and actuals</b><span>The first request can take a little while while historical Elexon records are retrieved.</span></div>}

        {activeView === 'overview' && <section className="metric-grid" aria-label="Forecast accuracy summary">
          <MetricCard label="Mean absolute error" value={number(metrics.maeMW, 0)} unit="MW" note="Average absolute forecast error" icon={Gauge} tone="blue" />
          <MetricCard label="Root mean squared error" value={number(metrics.rmseMW, 0)} unit="MW" note="Penalises larger misses" icon={Activity} tone="purple" />
          <MetricCard label="Forecast bias" value={number(metrics.biasMW, 0)} unit="MW" note={metrics.biasMW > 0 ? 'Forecasts tend to overestimate' : metrics.biasMW < 0 ? 'Forecasts tend to underestimate' : 'Forecast minus actual'} icon={metrics.biasMW < 0 ? ArrowDownRight : ArrowUpRight} tone="mint" />
          <MetricCard label="Matched intervals" value={number(metrics.matchedIntervals)} unit={`/${number(metrics.actualIntervals)}`} note={`${number(metrics.coveragePct, 1)}% forecast coverage`} icon={CheckCircle2} tone="amber" />
        </section>}

        {activeView === 'overview' && <section className="panel chart-panel">
          <div className="panel-heading">
            <div><div className="eyebrow">FORECAST PERFORMANCE</div><h2>Expected vs. actual generation</h2><p>National wind generation in megawatts · half-hourly resolution</p></div>
            <label className="select-wrap"><span>Delivery day</span><select value={selectedDay} onChange={(event) => setSelectedDay(event.target.value)} disabled={!days.length}>{days.map((day) => <option key={day} value={day}>{dateLabel(day)}</option>)}</select></label>
          </div>
          <div className="chart-legend"><span><i className="legend-dot forecast-dot" /> Day-ahead forecast</span><span><i className="legend-dot actual-dot" /> Actual generation</span><span className="chart-unit">MW</span></div>
          <div className="chart-wrap">
            {chartRows.length ? <ResponsiveContainer width="100%" height="100%"><LineChart data={chartRows} margin={{ top: 12, right: 18, left: 0, bottom: 3 }}>
              <CartesianGrid strokeDasharray="3 5" stroke="#e8edf4" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: '#8792a4', fontSize: 11 }} tickLine={false} axisLine={false} interval={5} />
              <YAxis tick={{ fill: '#8792a4', fontSize: 11 }} tickLine={false} axisLine={false} width={58} tickFormatter={(value) => `${(value / 1000).toFixed(0)}k`} />
              <Tooltip content={<CustomTooltip />} />
              <Line type="monotone" name="Forecast" dataKey="forecastMW" stroke="#6e77f6" strokeWidth={2.4} dot={false} activeDot={{ r: 4, strokeWidth: 0 }} connectNulls={false} />
              <Line type="monotone" name="Actual" dataKey="actualMW" stroke="#16b89a" strokeWidth={2.4} dot={false} activeDot={{ r: 4, strokeWidth: 0 }} />
            </LineChart></ResponsiveContainer> : <div className="empty-chart">No records for this delivery date yet.</div>}
          </div>
          <div className="chart-footnote"><Clock3 size={14} /> Decision-time forecast selected using the configured cutoff: {payload?.decisionCutoff || '10:50 UTC previous day'}</div>
        </section>}

        {activeView === 'overview' && <section className="panel methodology-panel overview-methodology">
            <div className="eyebrow">HOW TO READ THIS</div><h2>Decision-ready, not hindsight</h2><p className="method-intro">A fair accuracy score must use the forecast the buyer could have seen at the time — not a forecast published later.</p>
            <div className="method-step"><div className="step-number">01</div><div><b>Choose the decision date</b><span>January 1–31, 2026.</span></div></div>
            <div className="method-step"><div className="step-number">02</div><div><b>Apply the cutoff</b><span>Use the latest forecast for each interval published by 10:50 UTC the day before delivery.</span></div></div>
            <div className="method-step"><div className="step-number">03</div><div><b>Compare with actuals</b><span>Match the forecast and actual generation on the same half-hour start time.</span></div></div>
            <div className="method-note"><AlertCircle size={16} /><span>The 10:50 UTC cutoff is an explicit MVP assumption. Confirm the precise decision deadline with the client. Wind data alone cannot calculate required procurement without demand data.</span></div>
        </section>}

        {activeView === 'accuracy' && <section className="accuracy-view" aria-label="Accuracy analysis">
          <div className="metric-grid">
            <MetricCard label="Mean absolute error" value={number(metrics.maeMW, 0)} unit="MW" note="Mean absolute error across matched intervals" icon={Gauge} tone="blue" />
            <MetricCard label="Root mean squared error" value={number(metrics.rmseMW, 0)} unit="MW" note="Root mean squared error across matched intervals" icon={Activity} tone="purple" />
            <MetricCard label="Forecast bias" value={number(metrics.biasMW, 0)} unit="MW" note="Mean forecast minus actual" icon={metrics.biasMW < 0 ? ArrowDownRight : ArrowUpRight} tone="mint" />
            <MetricCard label="Forecast coverage" value={`${number(metrics.coveragePct, 1)}%`} unit="" note={`${number(metrics.matchedIntervals)} matched of ${number(metrics.actualIntervals)} actual intervals`} icon={CheckCircle2} tone="amber" />
          </div>
          <div className="analysis-summary panel">
            <div><span>Over-forecast intervals</span><b>{number(errorDirection.over)}</b></div>
            <div><span>Under-forecast intervals</span><b>{number(errorDirection.under)}</b></div>
            <div><span>Exact matches</span><b>{number(errorDirection.exact)}</b></div>
          </div>
          <section className="panel distribution-panel">
            <div className="panel-heading"><div><div className="eyebrow">MATCHED INTERVAL ERROR</div><h2>Absolute error distribution</h2><p>Counts by absolute forecast error · MW · {number(matchedRows.length)} matched intervals</p></div></div>
            {matchedRows.length ? <div className="distribution-chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={errorDistribution} margin={{ top: 16, right: 18, left: 0, bottom: 28 }}>
              <CartesianGrid strokeDasharray="3 5" stroke="#e8edf4" vertical={false} />
              <XAxis dataKey="range" tick={{ fill: '#8792a4', fontSize: 10 }} tickLine={false} axisLine={false} angle={-25} textAnchor="end" interval={0} />
              <YAxis allowDecimals={false} tick={{ fill: '#8792a4', fontSize: 10 }} tickLine={false} axisLine={false} width={42} />
              <Tooltip />
              <Bar dataKey="count" name="Intervals" fill="#7478f0" radius={[5, 5, 0, 0]} />
            </BarChart></ResponsiveContainer></div> : <div className="empty-chart">No matched forecast intervals are available for error analysis.</div>}
            <div className="chart-footnote">Each matched interval contributes once. Missing forecasts are excluded, not counted as zero.</div>
          </section>
        </section>}

        {activeView === 'intervals' && <section className="panel table-panel interval-view" aria-label="Interval data">
          <div className="panel-heading compact"><div><div className="eyebrow">INTERVAL DETAIL</div><h2>Forecast error by settlement period</h2><p>{intervalMode === 'all' ? 'January decision window delivery intervals' : `${selectedDay ? dateLabel(selectedDay) : 'Selected day'} · UTC`}</p></div><div className="interval-controls">
            {intervalMode === 'day' && <label className="select-wrap"><span>Delivery day</span><select value={selectedDay} onChange={(event) => { setSelectedDay(event.target.value); setVisibleRows(PAGE_SIZE); }} disabled={!days.length}>{days.map((day) => <option key={day} value={day}>{dateLabel(day)}</option>)}</select></label>}
            <div className="tab-control"><button className={intervalMode === 'day' ? 'active' : ''} aria-pressed={intervalMode === 'day'} onClick={() => { setIntervalMode('day'); setVisibleRows(PAGE_SIZE); }}>Day</button><button className={intervalMode === 'all' ? 'active' : ''} aria-pressed={intervalMode === 'all'} onClick={() => { setIntervalMode('all'); setVisibleRows(PAGE_SIZE); }}>All month</button></div>
          </div></div>
          <div className="table-scroll"><table><thead><tr><th>TIME (UTC)</th><th>FORECAST</th><th>ACTUAL</th><th>ERROR</th><th>PUBLISHED</th></tr></thead><tbody>
            {intervalRows.map((row) => <tr key={row.startTime}><td className="time-cell">{dateLabel(dateKey(row))} {timeLabel(row.startTime)}</td><td>{row.forecastMW == null ? <span className="missing">Unavailable</span> : `${number(row.forecastMW)} MW`}</td><td>{number(row.actualMW)} MW</td><td className={row.errorMW == null ? '' : row.errorMW > 0 ? 'error-positive' : 'error-negative'}>{row.errorMW == null ? '—' : `${row.errorMW > 0 ? '+' : ''}${number(row.errorMW)} MW`}</td><td className="published-cell">{row.forecastPublishTime ? timeLabel(row.forecastPublishTime) : '—'}</td></tr>)}
            {!intervalRows.length && <tr><td colSpan="5" className="empty-table">{payload ? 'No actual intervals are available for this selection.' : 'Interval data will appear after analysis loads.'}</td></tr>}
          </tbody></table></div>
          <div className="table-footer">{intervalMode === 'all' ? `Showing ${Math.min(visibleRows, rows.length)} of ${rows.length} intervals.` : `Showing ${dayRows.length} intervals for ${selectedDay || 'selected day'}.`}{intervalMode === 'all' && visibleRows < rows.length && <button className="load-more-button" onClick={() => setVisibleRows((count) => Math.min(count + PAGE_SIZE, rows.length))}>Load more intervals</button>}</div>
        </section>}

        <footer className="app-footer"><div><span className="footer-mark"><Wind size={14} /></span> WINDLINE <span className="footer-divider">·</span> Elexon BMRS data</div><div>January 2026 decision window <span className="footer-divider">·</span> MW values</div></footer>
      </main>
    </div>
  );
}
