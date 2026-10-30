import type { AgDataSourcesDefinition } from "ag-studio";

export function buildStudioData(payload: {
  promises: Record<string, unknown>[];
  verification_items: Record<string, unknown>[];
}): AgDataSourcesDefinition {
  return {
    sources: [
      {
        id: "promises",
        name: "Promises",
        data: payload.promises,
      },
      {
        id: "verification_items",
        name: "Verification items",
        data: payload.verification_items,
      },
    ],
    relationships: [
      {
        id: "verification-to-promise",
        source: { tableId: "verification_items", fieldId: "promise_id" },
        target: { tableId: "promises", fieldId: "promise_id" },
        type: "many-to-one",
      },
    ],
  };
}
