# CanvasFlow

CanvasFlow is an agent-driven generative UI workbench for turning a user goal into a reviewable, executable interface. The repository is a small npm workspace monorepo initialized around the airport pickup POC.

## Repository layout

- `packages/schema`: the only cross-package contract for TaskState, events, tools, and UISpec.
- `packages/agent`: deterministic task engine with event idempotency and phase transitions.
- `packages/tools`: fixture Provider registry and validated tool results.
- `packages/ui`: deterministic UISpec Composer and schema-safe UI projection.
- `apps/demo`: 1920 x 720-oriented fixture event console for stepping through the same task card.
- `fixtures/airport-pickup`: twelve self-contained scenario contracts for Agent, tools, and UI tests.

## Development

```bash
npm install
npm run dev
npm run lint
npm run typecheck
npm test
npm run build
```

The demo starts in Fixture mode. It intentionally has no model key, vehicle credential, or live provider dependency. Future live integrations must keep the same Schema and Provider contracts.
