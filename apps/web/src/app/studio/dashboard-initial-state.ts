import type { AgReportState } from "ag-studio";

/** Pre-built payer dashboard (Overview + Verification evidence). */
export const DASHBOARD_INITIAL_STATE: AgReportState = {
  version: "3.0.0",
  selectedPageId: "overview",
  pages: [
    {
      id: "overview",
      widgets: {
        "kpi-volume": {
          type: "value",
          dataMapping: {
            value: [{ id: "promises.amount_dollars", aggregation: "sum" }],
          },
          format: {
            title: { enabled: true, text: "Total promise volume ($)" },
            style: { typography: { fontSize: 28, fontWeight: "bold" }, verticalAlign: "center" },
          },
        },
        "kpi-count": {
          type: "value",
          dataMapping: {
            value: [{ id: "promises.promise_id", aggregation: "count" }],
          },
          format: {
            title: { enabled: true, text: "Promises" },
            style: { typography: { fontSize: 28, fontWeight: "bold" }, verticalAlign: "center" },
          },
        },
        "kpi-review": {
          type: "value",
          dataMapping: {
            value: [{ id: "promises.needs_review", aggregation: "sum" }],
          },
          format: {
            title: { enabled: true, text: "Needs your review" },
            style: { typography: { fontSize: 28, fontWeight: "bold" }, verticalAlign: "center" },
          },
        },
        "status-pie": {
          type: "donut-chart",
          dataMapping: {
            categoryKey: [{ id: "promises.status_label" }],
            valueKey: [{ id: "promises.promise_id", aggregation: "count" }],
          },
          format: {
            title: { enabled: true, text: "Promises by status" },
          },
        },
        "amount-by-status": {
          type: "column-chart-grouped",
          dataMapping: {
            categoryKey: [{ id: "promises.status_label" }],
            valueKey: [{ id: "promises.amount_dollars", aggregation: "sum" }],
          },
          format: {
            title: { enabled: true, text: "Dollars held or paid by status" },
          },
        },
        "status-filter": {
          type: "list-filter",
          dataMapping: {
            value: [{ id: "promises.status_label" }],
          },
          format: {
            title: { enabled: true, text: "Filter status" },
          },
        },
        "pipeline-grid": {
          type: "grid",
          dataMapping: {
            cols: [
              { id: "promises.title" },
              { id: "promises.worker_email" },
              { id: "promises.status_label" },
              { id: "promises.amount_dollars" },
              { id: "promises.funded" },
              { id: "promises.deadline_at" },
            ],
          },
          format: {
            title: { enabled: true, text: "Promise pipeline" },
            style: { columnAutoSize: true },
          },
        },
      },
      widgetLayout: {
        "kpi-volume": { xTrack: 0, yTrack: 0, xSpan: 8, ySpan: 10 },
        "kpi-count": { xTrack: 8, yTrack: 0, xSpan: 8, ySpan: 10 },
        "kpi-review": { xTrack: 16, yTrack: 0, xSpan: 8, ySpan: 10 },
        "status-filter": { xTrack: 0, yTrack: 10, xSpan: 6, ySpan: 22 },
        "status-pie": { xTrack: 6, yTrack: 10, xSpan: 9, ySpan: 22 },
        "amount-by-status": { xTrack: 15, yTrack: 10, xSpan: 9, ySpan: 22 },
        "pipeline-grid": { xTrack: 0, yTrack: 32, xSpan: 24, ySpan: 28 },
      },
    },
    {
      id: "verifications",
      widgets: {
        "verdict-chart": {
          type: "bar-chart-grouped",
          dataMapping: {
            categoryKey: [{ id: "verification_items.verdict" }],
            valueKey: [{ id: "verification_items.verification_id", aggregation: "count" }],
          },
          format: {
            title: { enabled: true, text: "Verifications by verdict" },
          },
        },
        "evidence-grid": {
          type: "grid",
          dataMapping: {
            cols: [
              { id: "verification_items.promise_title" },
              { id: "verification_items.verdict" },
              { id: "verification_items.checklist_item" },
              { id: "verification_items.passed" },
              { id: "verification_items.confidence" },
              { id: "verification_items.model" },
              { id: "verification_items.created_at" },
            ],
          },
          format: {
            title: { enabled: true, text: "AI checklist evidence" },
            style: { columnAutoSize: true },
          },
        },
      },
      widgetLayout: {
        "verdict-chart": { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 18 },
        "evidence-grid": { xTrack: 0, yTrack: 18, xSpan: 24, ySpan: 34 },
      },
    },
  ],
};
