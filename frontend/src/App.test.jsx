// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from './App.jsx';

vi.mock('recharts', () => {
  const Chart = ({ children }) => <div>{children}</div>;
  const Empty = () => null;
  return {
    Bar: Empty,
    BarChart: Chart,
    CartesianGrid: Empty,
    Line: Empty,
    LineChart: Chart,
    ResponsiveContainer: Chart,
    Tooltip: Empty,
    XAxis: Empty,
    YAxis: Empty,
  };
});

function makePayload() {
  const data = Array.from({ length: 55 }, (_, index) => {
    const start = new Date(Date.UTC(2026, 0, 2, 0, index * 30));
    const startTime = start.toISOString();
    const forecastMW = index === 0 ? null : 110 + index;
    const actualMW = 100 + index;
    return {
      startTime,
      deliveryDate: startTime.slice(0, 10),
      decisionDate: '2026-01-01',
      forecastPublishTime: forecastMW == null ? null : '2026-01-01T10:50:00+00:00',
      forecastMW,
      actualMW,
      errorMW: forecastMW == null ? null : forecastMW - actualMW,
      absErrorMW: forecastMW == null ? null : Math.abs(forecastMW - actualMW),
    };
  });
  return {
    decisionCutoff: '10:50 UTC on the day before delivery (MVP assumption)',
    metrics: {
      maeMW: 42,
      rmseMW: 45,
      biasMW: -3,
      matchedIntervals: 54,
      actualIntervals: 55,
      coveragePct: 98.18,
    },
    data,
  };
}

function successResponse(body) {
  return { ok: true, json: async () => body };
}

describe('Windline dashboard', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue(successResponse(makePayload()));
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:windline-test'),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('switches views and marks the selected navigation item', async () => {
    render(<App />);
    await screen.findByText('42');

    const accuracy = screen.getByRole('button', { name: 'Accuracy analysis' });
    fireEvent.click(accuracy);

    expect(screen.getByRole('heading', { name: 'Wind forecast accuracy' })).toBeTruthy();
    expect(accuracy.className).toContain('selected');
    expect(accuracy.getAttribute('aria-current')).toBe('page');
    expect(screen.getByText('Absolute error distribution')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Forecast overview' }));
    expect(screen.getByRole('heading', { name: 'Wind forecast overview' })).toBeTruthy();
  });

  it('shows a missing forecast as unavailable and paginates all-month intervals', async () => {
    render(<App />);
    await screen.findByText('42');
    fireEvent.click(screen.getByRole('button', { name: 'Interval data' }));

    const table = screen.getByRole('table');
    expect(within(table).getByText('Unavailable')).toBeTruthy();
    expect(within(table).getAllByText('—')).toHaveLength(2);
    expect(within(table).getAllByRole('row')).toHaveLength(49);

    fireEvent.click(screen.getByRole('button', { name: 'All month' }));
    expect(within(table).getAllByRole('row')).toHaveLength(49);
    fireEvent.click(screen.getByRole('button', { name: 'Load more intervals' }));
    expect(within(table).getAllByRole('row')).toHaveLength(56);
    expect(screen.getByText('Showing 55 of 55 intervals.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Day' }));
    expect(within(table).getAllByRole('row')).toHaveLength(49);
    expect(screen.getByLabelText('Delivery day')).toBeTruthy();
  });

  it('reports refresh failure and keeps previously loaded data available', async () => {
    globalThis.fetch
      .mockResolvedValueOnce(successResponse(makePayload()))
      .mockRejectedValueOnce(new Error('Network unavailable'));
    render(<App />);
    await screen.findByText('42');
    fireEvent.click(screen.getByRole('button', { name: 'Interval data' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh data' }));

    expect(await screen.findByText('Unable to refresh data')).toBeTruthy();
    expect(screen.getByText(/previously loaded dashboard is still available/)).toBeTruthy();
    expect(screen.getByText('100 MW')).toBeTruthy();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('distinguishes an analysis failure after a successful refresh', async () => {
    globalThis.fetch
      .mockResolvedValueOnce(successResponse(makePayload()))
      .mockResolvedValueOnce(successResponse({ status: 'cache_cleared' }))
      .mockRejectedValueOnce(new Error('Analysis unavailable'));
    render(<App />);
    await screen.findByText('42');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh data' }));

    expect(await screen.findByText('Unable to load analysis')).toBeTruthy();
    expect(screen.getByText(/Analysis unavailable/)).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
  });

  it('exports all returned rows as CSV', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<App />);
    await screen.findByText('42');
    fireEvent.click(screen.getByRole('button', { name: 'Export data' }));

    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
    expect(click).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect(click.mock.instances[0]?.download).toBe('uk-wind-forecast-accuracy-jan-2026.csv');
    const blob = URL.createObjectURL.mock.calls[0][0];
    const csv = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsText(blob);
    });
    expect(csv.split('\n')).toHaveLength(56);
    expect(csv).toContain('2026-01-03T03:00:00.000Z');
  });
});
